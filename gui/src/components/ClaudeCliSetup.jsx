import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Copy, ExternalLink, Loader2, RefreshCw, Download } from 'lucide-react';
import { openExternal } from '../utils/openExternal';
import { writeClipboard } from '../utils/clipboard';

// The Claude Code CLI: whether `claude` is found, and how to get it
// (/api/claude/cli, claude_cli.py). Shown in the Claude Code panel when the
// CLI is missing and in Settings > Dependencies.
//
// The desktop app is what a web search for "Claude Code" usually installs, and
// it provides no `claude` command, so the card says plainly which program
// GilzaCode needs. The install button runs Anthropic's own installer, whose
// command is shown before it is clicked.

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const smallText = { fontSize: '11px', lineHeight: 1.45 };

export default function ClaudeCliSetup({ onAvailable }) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [installError, setInstallError] = React.useState('');
  const [output, setOutput] = React.useState('');
  const [justInstalled, setJustInstalled] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Held in a ref so a caller's inline callback does not re-run the check.
  const onAvailableRef = React.useRef(onAvailable);
  onAvailableRef.current = onAvailable;

  const apply = React.useCallback((next) => {
    setStatus(next);
    setStatusError('');
    if (next?.available) onAvailableRef.current?.(next);
  }, []);

  const check = React.useCallback(() => {
    setChecking(true);
    return fetch('/api/claude/cli')
      .then(readJson)
      .then(apply)
      .catch(err => setStatusError(String(err.message || err)))
      .finally(() => setChecking(false));
  }, [apply]);

  React.useEffect(() => { check(); }, [check]);

  const install = () => {
    setInstalling(true);
    setInstallError('');
    setOutput('');
    setJustInstalled(false);
    fetch('/api/claude/cli/install', { method: 'POST' })
      .then(readJson)
      .then(next => {
        setOutput(next.output || '');
        setJustInstalled(true);
        apply(next);
      })
      .catch(err => setInstallError(String(err.message || err)))
      .finally(() => setInstalling(false));
  };

  const copyCommand = async () => {
    if (await writeClipboard(status?.install_command || '')) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const guideUrl = status?.guide_url || 'https://code.claude.com/docs/en/setup';
  const available = Boolean(status?.available);

  return (
    <div className="flex flex-col" style={{ gap: '8px' }}>
      {!status && !statusError && (
        <span role="status" style={smallText}>{t('claudeCli.checking', 'Looking for the Claude Code CLI…')}</span>
      )}
      {statusError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>
          {t('claudeCli.statusError', 'Could not check for Claude Code: ')}{statusError}
        </span>
      )}

      {available && (
        <span role="status" style={{ ...smallText, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--battery-good)' }}>
          <CheckCircle2 size={13} />
          {justInstalled
            ? t('claudeCli.installed', { path: status.path, defaultValue: 'Claude Code CLI installed: {{path}}' })
            : t('claudeCli.found', { path: status.path, defaultValue: 'Claude Code CLI found: {{path}}' })}
        </span>
      )}
      {available && justInstalled && (
        <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
          {t('claudeCli.signInHint', 'The first time Claude Code starts in the panel, it asks you to sign in to your Claude account (Pro, Max, Team or Enterprise) or to use an API key.')}
        </span>
      )}

      {status && !available && (
        <>
          <span role="alert" style={{ fontSize: '12px', lineHeight: 1.45, color: 'var(--vscode-errorForeground)' }}>
            {t('claudeCli.missing', 'The Claude Code CLI (the `claude` command) was not found.')}
          </span>
          {status.desktop_app_installed && (
            <span style={{ ...smallText, padding: '6px 8px', border: '1px solid var(--vscode-border)', borderRadius: 4 }}>
              {t('claudeCli.desktopAppFound', 'The Claude desktop app is installed, but it does not provide the `claude` command. GilzaCode needs the command-line version, a separate program. Installing it does not change the desktop app.')}
            </span>
          )}
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('claudeCli.whichOne', 'GilzaCode runs Claude Code for the terminal (CLI). Web searches and the Claude website often lead to the desktop app instead, which is not what GilzaCode uses.')}
          </span>
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('claudeCli.officialCommand', { shell: status.install_shell, defaultValue: 'Official installer ({{shell}}), the one the button runs:' })}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <code style={{
              flex: 1, minWidth: 0, padding: '4px 8px', fontSize: '12px', userSelect: 'text', overflowX: 'auto', whiteSpace: 'nowrap',
              background: 'var(--vscode-sidebar-bg)', border: '1px solid var(--vscode-border)', borderRadius: 4,
            }}>{status.install_command}</code>
            <button type="button" className="git-icon-button" onClick={copyCommand}
              title={copied ? t('claudeCli.copied', 'Copied') : t('claudeCli.copy', 'Copy the command')}>
              {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {status && !available && (
          <button type="button" className="vscode-button" disabled={installing} onClick={install}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {installing ? t('claudeCli.installing', 'Installing…') : t('claudeCli.installBtn', 'Install Claude Code CLI')}
          </button>
        )}
        <button type="button" className="vscode-button-secondary" onClick={() => openExternal(guideUrl)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ExternalLink size={12} /> {t('claudeCli.guideBtn', 'Installation guide')}
        </button>
        <button type="button" className="vscode-button-secondary" disabled={checking || installing} onClick={check}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={12} /> {t('claudeCli.checkAgain', 'Check again')}
        </button>
      </div>

      {installing && (
        <span role="status" style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
          {t('claudeCli.installingHint', 'The installer downloads Claude Code and shows no progress; this can take a minute or two.')}
        </span>
      )}
      {installError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>
          {installError}
        </span>
      )}
      {output && (
        <pre style={{ margin: 0, maxHeight: 140, overflow: 'auto', fontSize: '11px', whiteSpace: 'pre-wrap', userSelect: 'text', opacity: 0.85 }}>{output}</pre>
      )}
    </div>
  );
}
