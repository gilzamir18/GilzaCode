import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, Cloud, CloudOff, RefreshCw, AlertTriangle, Check, ExternalLink, KeyRound,
  ChevronDown, ChevronRight, ArrowUp, ArrowDown, Trash2, Square,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './CustomDialogProvider';
import { handleExternalClick } from '../../utils/openExternal';

function TabButton({ active, onClick, children }) {
  return (
    <button className={`vscode-modal-tab${active ? ' active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }) {
  return (
    <label
      className="flex items-start"
      style={{ gap: '8px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
    >
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: '2px' }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '12px' }}>{label}</span>
        {hint && (
          <span style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>{hint}</span>
        )}
      </span>
    </label>
  );
}

// Per-project cloud mirroring: pick a backend, connect it, choose what travels,
// and run a pass by hand.
export default function CloudSyncModal({ activeProject, onClose, onWorkspaceChanged }) {
  const { t } = useTranslation();
  const { showConfirm } = useCustomDialog();

  const projectPath = activeProject?.project_path || '';
  const projectName = activeProject?.name || '';

  const [activeTab, setActiveTab] = useState('sync');
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lastReport, setLastReport] = useState(null);
  // Which OAuth client this installation connects with. Normally the one
  // shipped with the build, in which case the user never sees a client id.
  const [googleClient, setGoogleClient] = useState(null);
  const [customClientId, setCustomClientId] = useState('');
  const [customClientSecret, setCustomClientSecret] = useState('');
  const [showCustomClient, setShowCustomClient] = useState(false);
  const [pendingAuthUrl, setPendingAuthUrl] = useState('');
  // Path currently being resolved, so its buttons can show they are working.
  const [resolvingPath, setResolvingPath] = useState('');

  // Guards a state update from an in-flight request after the modal closed.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadStatus = useCallback(async () => {
    if (!projectPath) return;
    try {
      const params = new URLSearchParams({ projectPath, project: projectName });
      const res = await fetch(`/api/cloud/status?${params}`);
      const payload = await res.json();
      if (!mounted.current) return;
      if (payload.error) { setError(payload.error); return; }
      setStatus(payload);
      setSettings(payload.settings);
      if (payload.last_outcome?.report) setLastReport(payload.last_outcome.report);
    } catch (e) {
      if (mounted.current) setError(String(e));
    }
  }, [projectPath, projectName]);

  const loadGoogleClient = useCallback(async () => {
    try {
      const res = await fetch('/api/cloud/google-client');
      const payload = await res.json();
      if (!mounted.current) return;
      setGoogleClient(payload);
      setCustomClientId(payload.custom_client_id || '');
      // A build with no client of its own cannot connect until the user
      // registers one, so that form opens instead of hiding behind a
      // disclosure the user has no reason to look inside.
      if (!payload.configured) setShowCustomClient(true);
    } catch (_) { /* the panel still works without it */ }
  }, []);

  useEffect(() => { loadStatus(); loadGoogleClient(); }, [loadStatus, loadGoogleClient]);

  const passRunning = !!status?.syncing || !!status?.progress?.active;
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelling = cancelRequested || !!status?.progress?.cancel_requested;

  // The flag belongs to one pass; the next one starts uncancelled.
  useEffect(() => {
    if (!passRunning && busy !== 'sync' && busy !== 'preview') setCancelRequested(false);
  }, [passRunning, busy]);

  // Stops whichever pass is running — one started here, or a background one.
  // The engine checks between files, so the file in flight still finishes.
  const cancelSync = async () => {
    setCancelRequested(true);
    setError('');
    try {
      const res = await fetch('/api/cloud/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      const payload = await res.json();
      if (payload.error) { setError(payload.error); setCancelRequested(false); return; }
      if (!payload.cancel_requested) setCancelRequested(false);
      await loadStatus();
    } catch (e) {
      if (mounted.current) { setError(String(e)); setCancelRequested(false); }
    }
  };

  useEffect(() => {
    // The panel is the place the user watches a pass from, so while one is
    // running it refreshes every second instead of only when an action ends.
    if (!passRunning) return undefined;
    const timer = setInterval(loadStatus, 1000);
    return () => clearInterval(timer);
  }, [passRunning, loadStatus]);

  // Settle one conflicted file. "Keep both" is what a conflict already left
  // behind, so it only clears the entry from the list — there is nothing for
  // the backend to do.
  const resolveConflict = async (conflict, resolution) => {
    const drop = () => setLastReport((current) => (current ? {
      ...current,
      conflicts: (current.conflicts || []).filter((item) => item.path !== conflict.path),
    } : current));

    if (resolution === 'keep_both') { drop(); return; }

    setResolvingPath(conflict.path);
    setError('');
    try {
      const res = await fetch('/api/cloud/resolve-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          project: projectName,
          path: conflict.path,
          resolution,
          conflict_copy: conflict.conflict_copy,
        }),
      });
      const payload = await res.json();
      if (!res.ok || payload.error) { setError(payload.error || `HTTP ${res.status}`); return; }
      drop();
      if (payload.status) { setStatus(payload.status); setSettings(payload.status.settings); }
      onWorkspaceChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setResolvingPath('');
    }
  };

  const saveSettings = async (changes) => {
    setError('');
    const next = { ...settings, ...changes };
    setSettings(next);
    try {
      const res = await fetch('/api/cloud/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, project: projectName, settings: changes }),
      });
      const payload = await res.json();
      if (payload.error) { setError(payload.error); return; }
      setStatus(payload);
      setSettings(payload.settings);
    } catch (e) {
      setError(String(e));
    }
  };

  const saveGoogleClient = async () => {
    setBusy('client');
    setError('');
    try {
      const res = await fetch('/api/cloud/google-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: customClientId, client_secret: customClientSecret }),
      });
      const payload = await res.json();
      if (payload.error) { setError(payload.error); return; }
      // The secret is write-only: it is never sent back, so the field is
      // cleared rather than left holding a value the user cannot verify.
      setCustomClientSecret('');
      await loadGoogleClient();
      await loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  // Drop the user's own client and go back to the one shipped with the build.
  const useBundledClient = async () => {
    setBusy('client');
    setError('');
    try {
      const res = await fetch('/api/cloud/google-client', { method: 'DELETE' });
      const payload = await res.json();
      if (payload.error) { setError(payload.error); return; }
      setCustomClientSecret('');
      await loadGoogleClient();
      await loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const connect = async () => {
    if (!settings?.provider) return;
    setBusy('connect');
    setError('');
    setPendingAuthUrl('');
    try {
      const res = await fetch('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: settings.provider, config: settings.provider_config || {} }),
      });
      const challenge = await res.json();
      if (challenge.error) { setError(challenge.error); return; }
      // Shown so the user can still finish the flow when no browser could be
      // launched — a headless session, or a sandbox without a portal.
      setPendingAuthUrl(challenge.authorization_url || '');

      const done = await fetch('/api/cloud/connect/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: settings.provider,
          session: challenge.session,
          config: settings.provider_config || {},
        }),
      });
      const result = await done.json();
      if (result.error) { setError(result.error); return; }
      setPendingAuthUrl('');
      await loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const disconnect = async () => {
    const ok = await showConfirm(
      t('cloudSync.disconnectConfirm', 'Disconnect this account? Files already in the cloud are kept.'),
    );
    if (!ok) return;
    setBusy('disconnect');
    try {
      await fetch('/api/cloud/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: settings.provider, config: settings.provider_config || {} }),
      });
      await loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const runSync = async ({ dryRun = false, allowBulkDelete = false } = {}) => {
    setBusy(dryRun ? 'preview' : 'sync');
    setError('');
    try {
      const res = await fetch('/api/cloud/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, project: projectName, dryRun, allowBulkDelete }),
      });
      const outcome = await res.json();
      if (outcome.error) { setError(outcome.error); return; }
      setLastReport(outcome.report);

      // The engine stops rather than propagate a mass deletion it cannot
      // distinguish from a bad listing; only the user can say which it was.
      if (outcome.report?.aborted?.includes('Refusing to delete')) {
        const confirmed = await showConfirm(
          `${t('cloudSync.bulkDeleteConfirm')}\n\n${outcome.report.aborted}`,
        );
        if (confirmed) { await runSync({ dryRun, allowBulkDelete: true }); return; }
      }
      if (!dryRun) {
        await loadStatus();
        onWorkspaceChanged?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  // The cloud folder this project mirrored to is gone — typically deleted
  // together with the project on another computer. The engine stopped without
  // touching anything; publishing a fresh copy means forgetting the old
  // baseline first, or it would read the new, empty folder as mass deletion.
  const republish = async () => {
    const ok = await showConfirm(
      t('cloudSync.republishConfirm', 'Upload this project to the cloud again as a new copy?'),
    );
    if (!ok) return;
    setBusy('sync');
    setError('');
    try {
      const res = await fetch('/api/cloud/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      const payload = await res.json();
      if (payload.error) { setError(payload.error); setBusy(''); return; }
    } catch (e) {
      setError(String(e));
      setBusy('');
      return;
    }
    await runSync();
  };

  const providers = status?.providers || [];
  const currentProvider = providers.find((p) => p.id === settings?.provider);
  const connected = !!status?.connected;
  const needsAuth = !!currentProvider?.requires_authorization;
  const isGoogle = settings?.provider === 'google_drive';

  if (!activeProject) return null;

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal flex flex-col" style={{ width: '640px', maxHeight: 'calc(85 * var(--ui-vh))', padding: 0 }}>
        <div className="vscode-modal-header titlebar">
          <div className="vscode-modal-header-title">
            {connected ? <Cloud size={16} /> : <CloudOff size={16} />}
            <span>{t('cloudSync.title', 'Cloud sync')}</span>
          </div>
          <button className="vscode-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X size={16} />
          </button>
        </div>

        <div className="vscode-modal-tabs titlebar">
          <TabButton active={activeTab === 'sync'} onClick={() => setActiveTab('sync')}>
            {t('cloudSync.tabSync', 'Sync')}
          </TabButton>
          <TabButton active={activeTab === 'contents'} onClick={() => setActiveTab('contents')}>
            {t('cloudSync.tabContents', 'What is synced')}
          </TabButton>
          <TabButton active={activeTab === 'account'} onClick={() => setActiveTab('account')}>
            {t('cloudSync.tabAccount', 'Account')}
          </TabButton>
        </div>

        <div className="vscode-modal-content flex flex-col" style={{ overflowY: 'auto', gap: '14px' }}>
          {error && (
            <div
              className="flex items-start"
              style={{
                gap: '8px', padding: '8px 10px', fontSize: '11px',
                border: '1px solid var(--vscode-fg-danger)', color: 'var(--vscode-fg-danger)', borderRadius: '3px',
              }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'sync' && settings && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('cloudSync.provider', 'Provider')}
                </label>
                <select
                  value={settings.provider || ''}
                  onChange={(e) => saveSettings({ provider: e.target.value })}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                >
                  <option value="">{t('cloudSync.providerNone', 'Not configured')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.display_name}{p.available ? '' : ` — ${p.unavailable_reason}`}
                    </option>
                  ))}
                </select>
              </div>

              {settings.provider === 'local_folder' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                    {t('cloudSync.baseDir', 'Destination folder')}
                  </label>
                  <input
                    type="text"
                    className="vscode-settings-input"
                    value={settings.provider_config?.base_dir || ''}
                    placeholder={t('cloudSync.baseDirPlaceholder', 'C:\\Users\\you\\Google Drive\\GilzaCode')}
                    onChange={(e) => setSettings({
                      ...settings,
                      provider_config: { ...settings.provider_config, base_dir: e.target.value },
                    })}
                    onBlur={(e) => saveSettings({
                      provider_config: { ...settings.provider_config, base_dir: e.target.value },
                    })}
                  />
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('cloudSync.remoteFolder', 'Folder name in the cloud')}
                </label>
                <input
                  type="text"
                  className="vscode-settings-input"
                  value={settings.remote_folder || ''}
                  placeholder={activeProject.project_name || activeProject.name}
                  onChange={(e) => setSettings({ ...settings, remote_folder: e.target.value })}
                  onBlur={(e) => saveSettings({ remote_folder: e.target.value })}
                />
              </div>

              <Toggle
                label={t('cloudSync.enabled', 'Keep this project in the cloud')}
                hint={t('cloudSync.enabledHint', 'Nothing leaves this machine until you turn this on.')}
                checked={settings.enabled}
                disabled={!settings.provider}
                onChange={(value) => saveSettings({ enabled: value })}
              />
              <Toggle
                label={t('cloudSync.autoSync', 'Sync automatically after changes')}
                hint={t('cloudSync.autoSyncHint', {
                  defaultValue: 'Runs once the project has been idle for {{seconds}} seconds.',
                  seconds: settings.debounce_seconds,
                })}
                checked={settings.auto_sync}
                disabled={!settings.enabled}
                onChange={(value) => saveSettings({ auto_sync: value })}
              />

              <div className="flex items-center" style={{ gap: '8px', flexWrap: 'wrap' }}>
                <button
                  className="vscode-button"
                  disabled={!settings.enabled || !!busy || (needsAuth && !connected)}
                  onClick={() => runSync()}
                >
                  <RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} />
                  <span style={{ marginLeft: '6px' }}>
                    {busy === 'sync' ? t('cloudSync.syncing', 'Syncing…') : t('cloudSync.syncNow', 'Sync now')}
                  </span>
                </button>
                <button
                  className="vscode-button"
                  disabled={!settings.enabled || !!busy || (needsAuth && !connected)}
                  onClick={() => runSync({ dryRun: true })}
                >
                  {busy === 'preview' ? t('cloudSync.previewing', 'Checking…') : t('cloudSync.preview', 'Preview changes')}
                </button>
                {(passRunning || busy === 'sync' || busy === 'preview') && (
                  <button
                    className="vscode-button"
                    disabled={cancelling}
                    onClick={cancelSync}
                    title={t('cloudSync.cancelHint', 'Stops after the file being transferred now. What already moved stays synced.')}
                    style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                  >
                    <Square size={11} />
                    <span style={{ marginLeft: '6px' }}>
                      {cancelling ? t('cloudSync.cancelling', 'Cancelling…') : t('cloudSync.cancel', 'Cancel sync')}
                    </span>
                  </button>
                )}
              </div>

              {status?.last_sync_at && (
                <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                  {t('cloudSync.lastSync', {
                    defaultValue: 'Last sync: {{when}} · {{count}} file(s) tracked',
                    when: new Date(status.last_sync_at).toLocaleString(),
                    count: status.tracked_files,
                  })}
                </div>
              )}

              {status?.progress && (status.progress.active || status.progress.recent?.length > 0) && (
                <SyncProgressView progress={status.progress} active={passRunning} />
              )}

              {lastReport?.remote_missing && settings.enabled && (
                <div className="flex items-center" style={{ gap: '8px', flexWrap: 'wrap' }}>
                  <button className="vscode-button" disabled={!!busy} onClick={republish}>
                    {t('cloudSync.republish', 'Upload again as a new copy')}
                  </button>
                  <button
                    className="vscode-button"
                    disabled={!!busy}
                    onClick={() => saveSettings({ enabled: false })}
                  >
                    {t('cloudSync.turnOff', 'Turn off cloud sync')}
                  </button>
                </div>
              )}

              {lastReport && (
                <SyncReportView
                  report={lastReport}
                  onResolve={resolveConflict}
                  resolvingPath={resolvingPath}
                />
              )}
            </>
          )}

          {activeTab === 'contents' && settings && (
            <>
              <Toggle
                label={t('cloudSync.includeArtifacts', 'LaTeX build output')}
                hint={t('cloudSync.includeArtifactsHint', 'The compiled PDF, .aux, .log and friends. Turn off to sync sources only.')}
                checked={settings.include_build_artifacts}
                onChange={(value) => saveSettings({ include_build_artifacts: value })}
              />
              <Toggle
                label={t('cloudSync.includeDotenv', 'The project .env file')}
                hint={t('cloudSync.includeDotenvHint', 'It holds API keys. Turning this on copies those credentials into cloud storage.')}
                checked={settings.include_dotenv}
                onChange={async (value) => {
                  if (value) {
                    const ok = await showConfirm(
                      t('cloudSync.includeDotenvConfirm',
                        'The .env file holds your API keys. Upload it to cloud storage anyway?'),
                    );
                    if (!ok) return;
                  }
                  saveSettings({ include_dotenv: value });
                }}
              />

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('cloudSync.excludes', 'Never sync these (one pattern per line)')}
                </label>
                <textarea
                  className="vscode-settings-input"
                  rows={4}
                  style={{ width: '100%', fontFamily: 'var(--vscode-editor-font)', fontSize: '11px' }}
                  defaultValue={(settings.extra_excludes || []).join('\n')}
                  placeholder={'drafts/*\n*.bak'}
                  onBlur={(e) => saveSettings({
                    extra_excludes: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  })}
                />
              </div>

              <p style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', margin: 0, lineHeight: 1.5 }}>
                {t('cloudSync.alwaysExcluded',
                  'Always left out: the local checkpoint repository, this machine\'s sync state, node_modules and build caches.')}
              </p>
            </>
          )}

          {activeTab === 'account' && (
            <>
              {isGoogle && (
                <>
                  {/* Rendered only once the client is known: guessing would
                      flash the "register your own client" instructions at a
                      user who never has to see them. */}
                  <p style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', margin: 0, lineHeight: 1.5 }}>
                    {googleClient === null
                      ? ''
                      : googleClient.configured
                      ? t('cloudSync.googleConnectHelp',
                        'Connecting opens Google in your browser. GilzaCode only ever sees the folder it creates for your projects — it cannot read the rest of your Drive.')
                      : t('cloudSync.googleClientHelp',
                        'This build of GilzaCode ships no Google OAuth client, so you have to register one: create a "Desktop app" client in the Google Cloud console, enable the Google Drive API, and paste the credentials below.')}
                  </p>

                  <button
                    type="button"
                    onClick={() => setShowCustomClient((open) => !open)}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '4px',
                      fontSize: '11px', color: 'var(--vscode-text-subtle)',
                    }}
                  >
                    {showCustomClient ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t('cloudSync.useOwnClient', 'Use my own Google OAuth client')}
                  </button>

                  {googleClient?.source === 'user' && (
                    <span style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                      {t('cloudSync.usingOwnClient', {
                        defaultValue: 'Using your own OAuth client ({{clientId}}).',
                        clientId: googleClient.client_id,
                      })}
                    </span>
                  )}
                  {googleClient?.source === 'environment' && (
                    <span style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
                      {t('cloudSync.usingEnvClient',
                        'Using the OAuth client from GILZACODE_GDRIVE_CLIENT_ID; it overrides anything set here.')}
                    </span>
                  )}

                  {showCustomClient && (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                          {t('cloudSync.clientId', 'Client ID')}
                        </label>
                        <input
                          type="text"
                          className="vscode-settings-input"
                          value={customClientId}
                          onChange={(e) => setCustomClientId(e.target.value)}
                          placeholder="1234567890-abc.apps.googleusercontent.com"
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                          {t('cloudSync.clientSecret', 'Client secret')}
                        </label>
                        <input
                          type="password"
                          className="vscode-settings-input"
                          value={customClientSecret}
                          onChange={(e) => setCustomClientSecret(e.target.value)}
                          placeholder={googleClient?.has_custom_client_secret
                            ? t('cloudSync.clientSecretStored', 'Stored — leave blank to keep it')
                            : ''}
                        />
                      </div>
                      <div className="flex items-center" style={{ gap: '8px' }}>
                        <button
                          className="vscode-button"
                          onClick={saveGoogleClient}
                          disabled={busy === 'client' || !customClientId.trim()}
                        >
                          <KeyRound size={12} />
                          <span style={{ marginLeft: '6px' }}>
                            {t('cloudSync.saveClient', 'Save credentials')}
                          </span>
                        </button>
                        {googleClient?.source === 'user' && googleClient?.bundled_available && (
                          <button
                            className="vscode-button"
                            onClick={useBundledClient}
                            disabled={busy === 'client'}
                          >
                            {t('cloudSync.useBundledClient', 'Use the GilzaCode client')}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  <div style={{ height: '1px', backgroundColor: 'var(--vscode-border)' }} />
                </>
              )}

              <div className="flex items-center" style={{ gap: '8px' }}>
                {connected ? <Check size={14} style={{ color: 'var(--vscode-fg-success)' }} /> : <CloudOff size={14} />}
                <span style={{ fontSize: '12px' }}>
                  {connected
                    ? t('cloudSync.connectedAs', { defaultValue: 'Connected as {{account}}', account: status.account || '—' })
                    : t('cloudSync.notConnected', 'Not connected')}
                </span>
              </div>
              {status?.auth_error && (
                <span style={{ fontSize: '11px', color: 'var(--vscode-fg-danger)' }}>{status.auth_error}</span>
              )}

              {pendingAuthUrl && (
                <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)', lineHeight: 1.5 }}>
                  <div style={{ marginBottom: '4px' }}>
                    {t('cloudSync.waitingBrowser', 'Waiting for you to finish in the browser…')}
                  </div>
                  <a
                    href={pendingAuthUrl}
                    onClick={handleExternalClick(pendingAuthUrl)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--vscode-accent)', wordBreak: 'break-all', cursor: 'pointer' }}
                  >
                    <ExternalLink size={11} style={{ display: 'inline', marginRight: '4px' }} />
                    {pendingAuthUrl}
                  </a>
                </div>
              )}

              <div className="flex items-center" style={{ gap: '8px' }}>
                {needsAuth && !connected && (
                  <button
                    className="vscode-button"
                    disabled={!settings?.provider || busy === 'connect'}
                    onClick={connect}
                  >
                    <ExternalLink size={12} />
                    <span style={{ marginLeft: '6px' }}>
                      {busy === 'connect'
                        ? t('cloudSync.connecting', 'Waiting for authorization…')
                        : isGoogle
                          ? t('cloudSync.connectGoogle', 'Sign in with Google')
                          : t('cloudSync.connect', 'Connect')}
                    </span>
                  </button>
                )}
                {connected && needsAuth && (
                  <button className="vscode-button" onClick={disconnect} disabled={busy === 'disconnect'}>
                    {t('cloudSync.disconnect', 'Disconnect')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="vscode-modal-footer">
          <button onClick={onClose} className="vscode-button">{t('cloudSync.close', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}

// What a pass is doing right now, or what the last one moved. A pass used to
// run with no visible sign of it beyond a spinner.
function SyncProgressView({ progress, active }) {
  const { t } = useTranslation();
  const total = progress.total || 0;
  const examined = Math.min(progress.examined || 0, total);
  const percent = total ? Math.round((examined / total) * 100) : 0;
  const recent = [...(progress.recent || [])].reverse().slice(0, 8);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
      {active && (
        <>
          <div className="flex items-center justify-between">
            <span>
              {progress.current_path
                ? t(`cloudSync.action.${progress.current_action}`, progress.current_action)
                : t('cloudSync.scanning', 'Looking for changes…')}
              {progress.current_path ? ` ${progress.current_path}` : ''}
            </span>
            <span style={{ color: 'var(--vscode-text-subtle)' }}>
              {total ? `${examined}/${total}` : ''}
            </span>
          </div>
          <div style={{ height: '3px', backgroundColor: 'var(--vscode-border)', borderRadius: '2px' }}>
            <div
              style={{
                height: '100%', width: `${percent}%`, borderRadius: '2px',
                backgroundColor: 'var(--vscode-accent)', transition: 'width 200ms linear',
              }}
            />
          </div>
        </>
      )}

      {recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ color: 'var(--vscode-text-subtle)' }}>
            {active
              ? t('cloudSync.transferring', 'Transferred so far')
              : t('cloudSync.lastPassMoved', 'What the last pass moved')}
          </span>
          {recent.map((item, index) => (
            <div key={`${item.path}-${index}`} style={{ color: 'var(--vscode-text-subtle)' }}>
              {item.action === 'download' ? <ArrowDown size={10} style={{ display: 'inline' }} />
                : item.action === 'conflict' ? <AlertTriangle size={10} style={{ display: 'inline' }} />
                : item.action?.startsWith('delete') ? <Trash2 size={10} style={{ display: 'inline' }} />
                : <ArrowUp size={10} style={{ display: 'inline' }} />}
              <span style={{ marginLeft: '4px' }}>{item.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Outcome of the last pass. Conflicts come first: they are the only result that
// needs the user to do something.
function SyncReportView({ report, onResolve, resolvingPath }) {
  const { t } = useTranslation();
  const rows = [
    ['uploaded', report.uploaded],
    ['downloaded', report.downloaded],
    ['deleted_remote', report.deleted_remote],
    ['deleted_local', report.deleted_local],
    ['restored', report.restored],
  ].filter(([, list]) => (list || []).length > 0);

  if (!rows.length && !report.conflicts?.length && !report.errors?.length && !report.aborted) {
    return (
      <div style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>
        <Check size={12} style={{ display: 'inline', marginRight: '4px' }} />
        {t('cloudSync.upToDate', 'Everything is up to date.')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '11px' }}>
      {report.dry_run && (
        <span style={{ color: 'var(--vscode-text-subtle)' }}>
          {t('cloudSync.dryRunNotice', 'Preview only — nothing was transferred.')}
        </span>
      )}

      {(report.conflicts || []).map((conflict) => (
        <div
          key={conflict.path}
          style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            border: '1px solid var(--vscode-fg-warning)', borderRadius: '3px', padding: '8px',
          }}
        >
          <div style={{ color: 'var(--vscode-fg-warning)' }}>
            <AlertTriangle size={12} style={{ display: 'inline', marginRight: '4px' }} />
            {t('cloudSync.conflict', {
              defaultValue: '{{path}} changed in both places. Your version was kept; the cloud version is at {{copy}}.',
              path: conflict.path,
              copy: conflict.conflict_copy,
            })}
          </div>
          {onResolve && (
            <div className="flex items-center" style={{ gap: '6px', flexWrap: 'wrap' }}>
              <button
                className="vscode-button"
                disabled={!!resolvingPath}
                onClick={() => onResolve(conflict, 'keep_local')}
              >
                {resolvingPath === conflict.path
                  ? t('cloudSync.resolving', 'Applying…')
                  : t('cloudSync.keepLocal', 'Keep mine')}
              </button>
              <button
                className="vscode-button"
                disabled={!!resolvingPath}
                onClick={() => onResolve(conflict, 'keep_remote')}
              >
                {t('cloudSync.keepRemote', 'Keep the cloud version')}
              </button>
              <button
                className="vscode-button"
                disabled={!!resolvingPath}
                onClick={() => onResolve(conflict, 'keep_both')}
              >
                {t('cloudSync.keepBoth', 'Keep both')}
              </button>
            </div>
          )}
        </div>
      ))}

      {rows.map(([key, list]) => (
        <div key={key}>
          <span style={{ color: 'var(--vscode-text-subtle)' }}>
            {t(`cloudSync.report.${key}`, key)}:
          </span>{' '}
          <span>{list.length}</span>
          <div style={{ color: 'var(--vscode-text-subtle)', paddingLeft: '8px' }}>
            {list.slice(0, 8).join(', ')}{list.length > 8 ? '…' : ''}
          </div>
        </div>
      ))}

      {(report.errors || []).map((item) => (
        <div key={item.path} style={{ color: 'var(--vscode-fg-danger)' }}>{item.path}: {item.message}</div>
      ))}

      {report.cancelled && (
        <div style={{ color: 'var(--vscode-text-subtle)' }}>
          <Square size={10} style={{ display: 'inline', marginRight: '4px' }} />
          {t('cloudSync.cancelled', 'Sync cancelled. What moved before the stop is synced; the rest goes on the next pass.')}
        </div>
      )}

      {report.aborted && !report.cancelled && (
        <div style={{ color: 'var(--vscode-fg-danger)' }}>
          <AlertTriangle size={12} style={{ display: 'inline', marginRight: '4px' }} />
          {report.aborted}
        </div>
      )}

      {Object.keys(report.skipped || {}).length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--vscode-text-subtle)' }}>
            {t('cloudSync.skipped', {
              defaultValue: '{{count}} file(s) not synced',
              count: Object.keys(report.skipped).length,
            })}
          </summary>
          <div style={{ paddingLeft: '8px', color: 'var(--vscode-text-subtle)' }}>
            {Object.entries(report.skipped).slice(0, 40).map(([path, reason]) => (
              <div key={path}>{path} — {t(`cloudSync.skipReason.${reason}`, reason)}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
