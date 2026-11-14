import React from 'react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../utils/openExternal';

// Settings > General: the GilzaCode skills, a Claude Code plugin installed for
// the user through `claude plugin` (/api/claude/skills*, claude_plugins.py).
// Claude Code reads plugins when a session starts, so a session already
// running in the panel needs a restart or /reload-plugins afterwards.

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export default function ClaudeSkillsSection() {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState('');
  const [busy, setBusy] = React.useState(''); // '' | 'install' | 'update'
  const [message, setMessage] = React.useState('');
  const [actionError, setActionError] = React.useState('');

  const loadStatus = React.useCallback(() => {
    setStatusError('');
    return fetch('/api/claude/skills')
      .then(readJson)
      .then(setStatus)
      .catch(err => setStatusError(String(err.message || err)));
  }, []);

  React.useEffect(() => { loadStatus(); }, [loadStatus]);

  const run = (action) => {
    setBusy(action);
    setMessage('');
    setActionError('');
    fetch(`/api/claude/skills/${action}`, { method: 'POST' })
      .then(readJson)
      .then(next => {
        setStatus(next);
        setStatusError('');
        if (action === 'install') {
          setMessage(t('settingsModal.gilzacodeSkillsInstallSuccess'));
        } else if (next.updated) {
          setMessage(t('settingsModal.gilzacodeSkillsUpdateSuccess', { version: next.version }));
        } else {
          setMessage(t('settingsModal.gilzacodeSkillsUpToDate'));
        }
      })
      .catch(err => {
        const prefix = action === 'install'
          ? t('settingsModal.gilzacodeSkillsInstallError')
          : t('settingsModal.gilzacodeSkillsUpdateError');
        setActionError(prefix + String(err.message || err));
      })
      .finally(() => setBusy(''));
  };

  let stateText;
  if (statusError) stateText = null;
  else if (!status) stateText = t('settingsModal.gilzacodeSkillsChecking');
  else if (!status.installed) stateText = t('settingsModal.gilzacodeSkillsNotInstalled');
  else if (!status.enabled) stateText = t('settingsModal.gilzacodeSkillsDisabled', { version: status.version });
  else stateText = t('settingsModal.gilzacodeSkillsInstalled', { version: status.version });

  const installed = Boolean(status?.installed);
  const smallText = { fontSize: '11px', lineHeight: 1.4 };

  return (
    <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
      <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.gilzacodeSkillsTitle')}</label>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {!installed && (
          <button
            className="vscode-button"
            disabled={!status || Boolean(busy)}
            onClick={() => run('install')}
          >
            {busy === 'install' ? t('settingsModal.gilzacodeSkillsInstalling') : t('settingsModal.gilzacodeSkillsInstallBtn')}
          </button>
        )}
        {installed && (
          <button
            className="vscode-button"
            disabled={Boolean(busy)}
            onClick={() => run('update')}
          >
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
      {stateText && (
        <span role="status" style={{ ...smallText, color: 'var(--vscode-text-fg)' }}>{stateText}</span>
      )}
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
