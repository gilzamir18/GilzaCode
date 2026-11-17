import React, { useCallback, useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './modals/CustomDialogProvider';
import DiffViewer from './DiffViewer';

// The Git sidebar's "Agent" tab: each Claude Code turn of the panel that changed
// files (gilzacode/agent_history.py), newest first. A turn opens to its files;
// a file opens to the turn's diff of it. "Undo" puts back the turn's files as
// they were when it began, after asking; a file changed since the turn is named
// and overwritten only on a second, explicit confirmation.

const STATUS = {
  A: { color: 'var(--diff-text-added)', key: 'agentHistory.statusAdded', fallback: 'Created' },
  M: { color: 'var(--vscode-fg-gold)', key: 'agentHistory.statusModified', fallback: 'Modified' },
  D: { color: 'var(--vscode-errorForeground)', key: 'agentHistory.statusDeleted', fallback: 'Deleted' },
};

function formatWhen(seconds, language) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString(language || undefined, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function AgentHistoryPanel({ projectPath, refreshSignal = 0, isFileUnsaved, onUndone }) {
  const { t, i18n } = useTranslation();
  const { showConfirm, showAlert } = useCustomDialog();
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [openDiff, setOpenDiff] = useState(null); // { turn, path, text | null }
  const [undoing, setUndoing] = useState('');

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agent-history?projectPath=${encodeURIComponent(projectPath)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setHistory(data);
      setError('');
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => { load(); }, [load, refreshSignal]);
  useEffect(() => { setExpanded({}); setOpenDiff(null); }, [projectPath]);

  const showDiff = async (turnId, path) => {
    if (openDiff && openDiff.turn === turnId && openDiff.path === path) { setOpenDiff(null); return; }
    setOpenDiff({ turn: turnId, path, text: null });
    try {
      const params = new URLSearchParams({ projectPath, turn: turnId, path });
      const res = await fetch(`/api/agent-history/diff?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOpenDiff({ turn: turnId, path, text: data.diff || '' });
    } catch (err) {
      setOpenDiff(null);
      showAlert(String(err.message || err));
    }
  };

  const postUndo = (turnId, force) => fetch('/api/agent-history/undo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, turn: turnId, force }),
  }).then(async (res) => ({ res, data: await res.json().catch(() => ({})) }));

  const undo = async (turn) => {
    const paths = (turn.files || []).map(file => file.path);
    // The editor would write its unsaved buffer back over the undone file.
    const unsaved = paths.filter(path => isFileUnsaved?.(path));
    if (unsaved.length) {
      showAlert(t('agentHistory.undoUnsaved', { files: unsaved.join('\n'), defaultValue: 'Save or discard the unsaved changes in these files first:\n{{files}}' }));
      return;
    }
    const ok = await showConfirm(
      t('agentHistory.undoConfirm', { count: paths.length, files: paths.join('\n'), defaultValue: 'Put these files back as they were before this turn?\n{{files}}' }),
      t('agentHistory.undoTitle', 'Undo agent turn'),
    );
    if (!ok) return;
    setUndoing(turn.id);
    try {
      let { res, data } = await postUndo(turn.id, false);
      if (res.status === 409 && data.code === 'conflict') {
        const overwrite = await showConfirm(
          t('agentHistory.undoConflict', { files: (data.conflicts || []).join('\n'), defaultValue: 'These files changed after the turn, and undoing it discards those changes:\n{{files}}\n\nUndo anyway?' }),
          t('agentHistory.undoTitle', 'Undo agent turn'),
          { destructive: true },
        );
        if (!overwrite) return;
        ({ res, data } = await postUndo(turn.id, true));
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onUndone?.(data);
      await load();
    } catch (err) {
      showAlert(String(err.message || err));
    } finally {
      setUndoing('');
    }
  };

  const turns = history?.turns || [];
  const nested = history?.nested_repositories || [];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', flex: 1 }}>
          {history?.running
            ? t('agentHistory.running', 'Claude Code is working on a turn…')
            : t('agentHistory.subtitle', 'What each Claude Code turn in the panel changed.')}
        </span>
        <button className="git-icon-button" onClick={load} disabled={loading} title={t('agentHistory.refresh', 'Refresh')}>
          <RefreshCw size={12} />
        </button>
      </div>

      {nested.length > 0 && (
        <div role="note" className="agent-history-note">
          {t('agentHistory.nestedRepos', { folders: nested.join(', '), defaultValue: 'Folders with a Git repository of their own are not recorded: {{folders}}' })}
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: '11px', color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{error}</div>}

      {history && turns.filter(turn => turn.end).length === 0 && !error && (
        <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.5 }}>
          {t('agentHistory.empty', 'No turn has changed files yet. Each prompt you send to Claude Code in the panel becomes an entry here when it changes something. A session started before this feature records nothing until the panel restarts it.')}
        </div>
      )}

      {turns.filter(turn => turn.end).map((turn) => {
        const isOpen = !!expanded[turn.id];
        const files = turn.files || [];
        return (
          <div key={turn.id} className={`agent-history-turn${turn.undone_at ? ' undone' : ''}`}>
            <div className="agent-history-turn-head" onClick={() => setExpanded(prev => ({ ...prev, [turn.id]: !isOpen }))}>
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Bot size={12} style={{ flexShrink: 0, color: 'var(--vscode-accent, #4d9cf8)' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="agent-history-prompt" title={turn.prompt}>{turn.prompt || t('agentHistory.noPrompt', '(no prompt text)')}</div>
                <div className="agent-history-meta">
                  {formatWhen(turn.ended_at || turn.started_at, i18n.language)}
                  {' · '}
                  {t('agentHistory.fileCount', { count: files.length, defaultValue: '{{count}} files' })}
                  {turn.undone_at && <> {' · '}<strong>{t('agentHistory.undone', 'undone')}</strong></>}
                </div>
              </div>
              {!turn.undone_at && (
                <button
                  className="vscode-button secondary agent-history-undo"
                  disabled={Boolean(undoing) || history?.running}
                  title={history?.running ? t('agentHistory.undoWhileRunning', 'Wait for Claude Code to finish its turn') : t('agentHistory.undoHint', 'Put back the files this turn changed')}
                  onClick={(e) => { e.stopPropagation(); undo(turn); }}
                >
                  <RotateCcw size={11} /> {undoing === turn.id ? t('agentHistory.undoing', 'Undoing…') : t('agentHistory.undo', 'Undo')}
                </button>
              )}
            </div>
            {isOpen && (
              <div className="agent-history-files">
                {files.map((file) => {
                  const status = STATUS[file.status] || { color: 'var(--vscode-text-muted)', key: '', fallback: file.status };
                  const diffOpen = openDiff && openDiff.turn === turn.id && openDiff.path === file.path;
                  return (
                    <div key={file.path}>
                      <div className="agent-history-file" onClick={() => showDiff(turn.id, file.path)}
                        title={status.key ? t(status.key, status.fallback) : status.fallback}>
                        <span style={{ color: status.color, fontWeight: 700, width: '12px' }}>{file.status}</span>
                        <span className="agent-history-path">{file.path}</span>
                      </div>
                      {diffOpen && (openDiff.text === null
                        ? <div style={{ fontSize: '11px', color: 'var(--vscode-text-muted)', padding: '4px 0' }}>{t('gitSidebar.loadingDiff')}</div>
                        : <DiffViewer diff={openDiff.text} />)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
