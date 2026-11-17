import React from 'react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../utils/openExternal';
import { useCustomDialog } from './CustomDialogProvider';

// Settings > General: the GilzaCode skills, a Claude Code plugin installed
// through `claude plugin` (/api/claude/skills*, claude_plugins.py), in either
// of two scopes: global (the user's, every project) or only the open project,
// only for this user (Claude Code's `local` scope). Each scope has its own
// Install / Remove; Update brings every install up to date. Claude Code reads
// plugins when a session starts, so a session already running in the panel
// needs a restart or /reload-plugins afterwards.

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(readJson);

const smallText = { fontSize: '11px', lineHeight: 1.4 };

export default function ClaudeSkillsSection({ projectPath = '', projectName = '' }) {
  const { t } = useTranslation();
  const { showConfirm } = useCustomDialog();
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState('');
  const [busy, setBusy] = React.useState(''); // '' | 'update' | '<action>:<scope>'
  const [message, setMessage] = React.useState('');
  const [actionError, setActionError] = React.useState('');

  // `claude plugin list` takes seconds; an answer for a project that is no
  // longer the open one (Settings opened while the project was loading) must
  // not replace the current one's.
  const currentProjectRef = React.useRef(projectPath);
  currentProjectRef.current = projectPath;

  const loadStatus = React.useCallback(() => {
    setStatusError('');
    setStatus(null);
    const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
    return fetch(`/api/claude/skills${query}`)
      .then(readJson)
      .then(next => { if (currentProjectRef.current === projectPath) setStatus(next); })
      .catch(err => { if (currentProjectRef.current === projectPath) setStatusError(String(err.message || err)); });
  }, [projectPath]);

  React.useEffect(() => { loadStatus(); }, [loadStatus]);

  const scopeName = (scope) => (scope === 'user'
    ? t('settingsModal.gilzacodeSkillsScopeUser', 'Global (every project)')
    : t('settingsModal.gilzacodeSkillsScopeLocal', { project: projectName || projectPath, defaultValue: 'This project only ({{project}}), only for you' }));

  const act = async (action, scope) => {
    if (action === 'uninstall') {
      const ok = await showConfirm(
        t('settingsModal.gilzacodeSkillsRemoveConfirm', { scope: scopeName(scope), defaultValue: 'Remove the GilzaCode skills from: {{scope}}?' }),
        t('settingsModal.gilzacodeSkillsTitle'),
      );
      if (!ok) return;
    }
    setBusy(scope ? `${action}:${scope}` : action);
    setMessage('');
    setActionError('');
    try {
      const next = await post(`/api/claude/skills/${action}`, { scope, projectPath });
      setStatus(next);
      setStatusError('');
      if (action === 'install') setMessage(t('settingsModal.gilzacodeSkillsInstallSuccess'));
      else if (action === 'uninstall') setMessage(t('settingsModal.gilzacodeSkillsRemoveSuccess', 'Removed. Restart Claude Code, or type /reload-plugins in it, for the change to apply.'));
      else if (next.updated) setMessage(t('settingsModal.gilzacodeSkillsUpdateSuccessAll', 'Updated. Restart Claude Code, or type /reload-plugins in it, to load the new version.'));
      else setMessage(t('settingsModal.gilzacodeSkillsUpToDate'));
    } catch (err) {
      const prefix = {
        install: t('settingsModal.gilzacodeSkillsInstallError'),
        uninstall: t('settingsModal.gilzacodeSkillsRemoveError', 'Could not remove the GilzaCode skills: '),
        update: t('settingsModal.gilzacodeSkillsUpdateError'),
      }[action];
      setActionError(prefix + String(err.message || err));
    } finally {
      setBusy('');
    }
  };

  const stateText = (state) => {
    if (!state.installed) return t('settingsModal.gilzacodeSkillsNotInstalled');
    if (!state.enabled) return t('settingsModal.gilzacodeSkillsDisabled', { version: state.version });
    return t('settingsModal.gilzacodeSkillsInstalled', { version: state.version });
  };

  const scopes = status?.scopes || {};
  const anyInstalled = Object.values(scopes).some(state => state?.installed);

  const renderScope = (scope) => {
    const state = scopes[scope];
    const label = scopeName(scope);
    const pending = busy === `install:${scope}` || busy === `uninstall:${scope}`;
    return (
      <div key={scope} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px', alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '12px', color: 'var(--vscode-text-fg)' }}>{label}</div>
          <div role="status" style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {!status ? (statusError ? '' : t('settingsModal.gilzacodeSkillsChecking'))
              : state ? stateText(state)
                : t('settingsModal.gilzacodeSkillsNoProject', 'Open a project to install them only for it.')}
          </div>
        </div>
        {state && (
          <button
            className={state.installed ? 'vscode-button-secondary' : 'vscode-button'}
            disabled={Boolean(busy)}
            onClick={() => act(state.installed ? 'uninstall' : 'install', scope)}
          >
            {pending
              ? (state.installed ? t('settingsModal.gilzacodeSkillsRemoving', 'Removing…') : t('settingsModal.gilzacodeSkillsInstalling'))
              : (state.installed ? t('settingsModal.gilzacodeSkillsRemoveBtn', 'Remove') : t('settingsModal.gilzacodeSkillsInstallScopeBtn', 'Install'))}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col" style={{ gap: '8px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
      <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.gilzacodeSkillsTitle')}</label>
      {['user', 'local'].map(renderScope)}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {anyInstalled && (
          <button className="vscode-button" disabled={Boolean(busy)} onClick={() => act('update')}>
            {busy === 'update' ? t('settingsModal.gilzacodeSkillsUpdating') : t('settingsModal.gilzacodeSkillsUpdateBtn')}
          </button>
        )}
        {statusError && (
          <button className="vscode-button-secondary" disabled={Boolean(busy)} onClick={loadStatus}>
            {t('settingsModal.gilzacodeSkillsRetry')}
          </button>
        )}
        <button
          className="vscode-button-secondary"
          onClick={() => openExternal(status?.repository || 'https://github.com/gilzamir18/GilzaCodeSkills')}
        >
          {t('settingsModal.gilzacodeSkillsViewRepo')}
        </button>
      </div>
      {statusError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>
          {t('settingsModal.gilzacodeSkillsStatusError')}{statusError}
        </span>
      )}
      {message && (
        <span role="status" style={{ ...smallText, color: 'var(--battery-good)' }}>{message}</span>
      )}
      {actionError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>
          {actionError}
        </span>
      )}
      <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.gilzacodeSkillsHint')}</span>
    </div>
  );
}
