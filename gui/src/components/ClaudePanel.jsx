import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ClipboardPaste, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import TerminalInstance from './TerminalInstance';
import ClaudeCliSetup from './ClaudeCliSetup';
import { TERMINAL_FONT_SIZE_DEFAULT } from '../hooks/useTerminal';

// How long Claude Code must have been running before a staged prompt is pasted
// on its own. A session the panel has just started may still be showing a
// startup dialog (folder trust, a login), and text must never be typed into one.
const AUTO_PASTE_MIN_UPTIME_MS = 5000;

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// The panel where GilzaBots had its chat: Claude Code itself, running in a PTY in
// the project folder (terminal id `claude`, PROJECT_DESIGN.md §2).
//
// Document actions ("Ask about", "Fix with AI", the editor's inline prompts) hand
// it `promptRequest`. The text is pasted into Claude Code's composer, never
// submitted: the user reviews it and presses Enter. It is pasted on its own only
// into a session that has been running for a while and is quiet; otherwise it
// waits here, visible, with a button to paste it.
export default function ClaudePanel({ width, fillContainer, activeProject, promptRequest, restartRequest, onClose, theme, uiScale }) {
  const { t } = useTranslation();
  const projectPath = activeProject?.project_path || '';
  const [staged, setStaged] = useState('');
  const [notice, setNotice] = useState('');
  const [ended, setEnded] = useState(false);
  const [problem, setProblem] = useState('');
  // 'not_installed' shows how to install the CLI instead of the bare message.
  const [problemKind, setProblemKind] = useState('');
  const [connectionKey, setConnectionKey] = useState(0);
  // The stream dropped and EventSource is retrying. Not after `/exit`: the
  // server then ends the stream with an `ended` event and the panel says so at once.
  const [reconnecting, setReconnecting] = useState(false);
  const termRef = useRef(null);
  // The model service the session talks to, shown when it is not Anthropic's.
  const [provider, setProvider] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/model-provider')
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (!cancelled) setProvider(data?.provider || null); })
      .catch(() => { if (!cancelled) setProvider(null); });
    return () => { cancelled = true; };
  }, [restartRequest?.seq]);

  const readStatus = useCallback(async () => {
    if (!projectPath) return null;
    try {
      const res = await fetch(`/api/claude/status?${new URLSearchParams({ projectPath })}`);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }, [projectPath]);

  // A missing `claude` is said up front instead of as a dead terminal.
  useEffect(() => {
    setEnded(false);
    setProblem('');
    setProblemKind('');
    setReconnecting(false);
    readStatus().then(status => {
      if (status && !status.available) { setProblem(status.problem); setProblemKind(status.problem_kind || ''); }
    });
  }, [readStatus]);

  const paste = useCallback(async (text) => {
    try {
      const res = await postJson('/api/claude/paste', { projectPath, text });
      if (res.ok) {
        setStaged('');
        setNotice(t('claudePanel.pasted', 'Pasted into Claude Code. Review it and press Enter to send.'));
        termRef.current?.focus();
        return true;
      }
      const data = await res.json().catch(() => ({}));
      setNotice(data.error || t('claudePanel.pasteFailed', 'Could not paste into Claude Code.'));
    } catch (err) {
      setNotice(String(err));
    }
    return false;
  }, [projectPath, t]);

  useEffect(() => {
    if (!promptRequest?.text) return;
    let cancelled = false;
    setStaged(promptRequest.text);
    setNotice('');
    (async () => {
      const status = await readStatus();
      if (cancelled || !status?.running || status.uptime_ms < AUTO_PASTE_MIN_UPTIME_MS) return;
      await paste(promptRequest.text);
    })();
    return () => { cancelled = true; };
  }, [promptRequest?.seq]);

  const restart = async () => {
    setNotice('');
    const res = await postJson('/api/claude/start', { projectPath });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setProblem(data.error || t('claudePanel.startFailed', 'Claude Code could not be started.'));
      setProblemKind(data.kind || '');
      return;
    }
    setProblem('');
    setProblemKind('');
    setEnded(false);
    setReconnecting(false);
    setConnectionKey(k => k + 1);
  };

  // Saving another model provider closed the session (it had the old
  // environment). Start the new one, unless there was none to replace: the
  // user ended it, or `claude` is missing. A panel mounted after the change
  // (another layout, reopened) already starts with the new environment.
  const handledRestartSeqRef = useRef(restartRequest?.seq || 0);
  useEffect(() => {
    const seq = restartRequest?.seq || 0;
    if (seq <= handledRestartSeqRef.current) return;
    handledRestartSeqRef.current = seq;
    if (!projectPath || problem || ended) return;
    restart();
  }, [restartRequest?.seq]);

  const onConnectionChange = useCallback((state) => setReconnecting(state === 'reconnecting'), []);

  const onStreamClosed = useCallback(async () => {
    setReconnecting(false);
    const status = await readStatus();
    if (status && !status.available) { setProblem(status.problem); setProblemKind(status.problem_kind || ''); }
    else setEnded(true);
  }, [readStatus]);

  return (
    <aside
      className="vscode-chat"
      style={{
        ...(fillContainer ? { flex: 1, minWidth: 0, borderLeft: 'none', width: '100%' } : { width: `${width}px` }),
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div className="vscode-sidebar-header" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
        <Bot size={16} aria-hidden="true" />
        <span className="vscode-sidebar-title" style={{ flex: 1 }}>{t('claudePanel.title', 'Claude Code')}</span>
        {provider?.kind === 'ollama' && (
          <span
            title={t('claudePanel.ollamaBadgeTitle', { url: provider.ollama_url, defaultValue: 'Claude Code is using Ollama at {{url}}. Change it in Settings > General.' })}
            style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--vscode-border)', opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '50%' }}
          >
            Ollama · {provider.ollama_model}
          </span>
        )}
        {projectPath && !problem && (
          <button type="button" className="git-icon-button" onClick={restart}
            title={t('claudePanel.restart', 'Start a new Claude Code session')}>
            <RotateCcw size={14} />
          </button>
        )}
        {onClose && (
          <button type="button" className="git-icon-button" onClick={onClose} title={t('claudePanel.close', 'Hide the Claude Code panel')}>
            <X size={14} />
          </button>
        )}
      </div>

      {staged && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--vscode-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, opacity: 0.75 }}>{t('claudePanel.stagedPrompt', 'Prompt waiting for Claude Code:')}</span>
          <pre style={{ margin: 0, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, userSelect: 'text' }}>{staged}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="vscode-button" disabled={!!problem || ended}
              onClick={() => paste(staged)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ClipboardPaste size={12} /> {t('claudePanel.paste', 'Paste into Claude Code')}
            </button>
            <button type="button" className="vscode-button-secondary" onClick={() => setStaged('')}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Trash2 size={12} /> {t('claudePanel.discard', 'Discard')}
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div role="status" style={{ padding: '6px 12px', fontSize: 11, opacity: 0.85, borderBottom: '1px solid var(--vscode-border)' }}>{notice}</div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {!projectPath ? (
          <p style={{ margin: 12, opacity: 0.8 }}>{t('claudePanel.noProject', 'Open a project to start Claude Code in it.')}</p>
        ) : problemKind === 'not_installed' ? (
          // Installed from here (or found by "Check again"): start the session.
          <div style={{ position: 'absolute', inset: 0, padding: 12, overflowY: 'auto' }}>
            <ClaudeCliSetup onAvailable={restart} />
          </div>
        ) : problem ? (
          <p role="alert" style={{ margin: 12, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{problem}</p>
        ) : ended ? (
          <div style={{ margin: 12, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
            <span>{t('claudePanel.ended', 'Claude Code has ended.')}</span>
            <button type="button" className="vscode-button" onClick={restart}>{t('claudePanel.startAgain', 'Start Claude Code again')}</button>
          </div>
        ) : (<>
          <TerminalInstance
            termId="claude"
            activeProject={activeProject}
            activeBottomTab="terminal"
            bottomPanelHeight={0}
            isTerminalCollapsed={false}
            theme={theme}
            isActive
            fontSize={TERMINAL_FONT_SIZE_DEFAULT}
            uiScale={uiScale}
            onMount={(term) => { termRef.current = term; }}
            redrawPromptOnShow={false}
            onStreamClosed={onStreamClosed}
            onConnectionChange={onConnectionChange}
            connectionKey={connectionKey}
          />
          {reconnecting && (
            <div className="claude-panel-reconnecting" role="status" aria-live="polite">
              <div className="claude-panel-reconnecting-card">
                <Loader2 size={22} className="animate-spin" aria-hidden="true" />
                <span className="claude-panel-reconnecting-title">
                  {t('claudePanel.reconnecting', 'Waiting for Claude Code to reconnect…')}
                </span>
                <span className="claude-panel-reconnecting-hint">
                  {t('claudePanel.reconnectingHint', 'This takes a few seconds. If the session has ended, you can start it again.')}
                </span>
              </div>
            </div>
          )}
        </>)}
      </div>
    </aside>
  );
}
