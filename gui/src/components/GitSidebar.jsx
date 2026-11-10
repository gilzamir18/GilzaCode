import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronDown, ChevronLeft, ChevronRight, Plus, Minus, RotateCcw, GitCommit, History, GitBranch, FolderOpen, X, Eye, EyeOff, Bot, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './modals/CustomDialogProvider';
import { groupAgentTurns } from '../utils/gitReviewGrouping';

const REVIEW_HISTORY_PAGE_SIZE = 10;
const ALL_DIFF_FILES = '__all__';

function buildStatusMeta(t) {
  return {
    M:  { label: 'M', color: 'var(--vscode-fg-gold)', title: t('gitSidebar.statusModified') },
    A:  { label: 'A', color: 'var(--diff-text-added)', title: t('gitSidebar.statusAdded') },
    D:  { label: 'D', color: 'var(--vscode-errorForeground)', title: t('gitSidebar.statusDeleted') },
    R:  { label: 'R', color: 'var(--vscode-fg-info)', title: t('gitSidebar.statusRenamed') },
    C:  { label: 'C', color: 'var(--vscode-fg-info)', title: t('gitSidebar.statusCopied') },
    '??': { label: 'U', color: 'var(--diff-text-added)', title: t('gitSidebar.statusUntracked') },
  };
}

function parseDiffFileOptions(diff) {
  if (!diff) return [];
  const files = [];
  const seen = new Set();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    const path = match[2] === '/dev/null' ? match[1] : match[2];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

function commitDiffCacheKey(baseKey, filePath = ALL_DIFF_FILES) {
  return filePath === ALL_DIFF_FILES ? baseKey : `${baseKey}::${filePath}`;
}

function DiffViewer({ diff, wrapLines = false }) {
  const { t } = useTranslation();
  if (!diff || !diff.trim()) return (
    <div style={{ padding: '8px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>{t('gitSidebar.noDiff')}</div>
  );
  const lineStyle = {
    lineHeight: '1.5',
    whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
    overflowWrap: wrapLines ? 'anywhere' : 'normal',
    wordBreak: wrapLines ? 'break-word' : 'normal',
  };
  return (
    <div style={{ fontFamily: 'monospace', fontSize: '11px', overflowX: wrapLines ? 'hidden' : 'auto', background: 'var(--vscode-input-bg)', borderRadius: '4px', padding: '6px', border: '1px solid var(--vscode-border)' }}>
      {diff.split('\n').map((line, i) => {
        let bg = 'transparent';
        let color = 'var(--diff-text-default)';
        if (line.startsWith('+') && !line.startsWith('+++')) { bg = 'var(--diff-bg-added)'; color = 'var(--diff-text-added)'; }
        else if (line.startsWith('-') && !line.startsWith('---')) { bg = 'var(--diff-bg-removed)'; color = 'var(--diff-text-removed)'; }
        else if (line.startsWith('@@')) { color = 'var(--diff-text-meta)'; }
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) { color = 'var(--diff-text-header)'; }
        return (
          <div key={i} style={{ ...lineStyle, background: bg, color }}>{line || ' '}</div>
        );
      })}
    </div>
  );
}

function FileRow({ file, projectPath, onStage, onUnstage, onDiscard, onToggleDiff, expandedDiff, diff, loadingDiff }) {
  const { t } = useTranslation();
  const statusMeta = buildStatusMeta(t);
  const meta = statusMeta[file.status] || { label: file.status || '?', color: 'var(--vscode-text-muted)', title: file.status };
  const isStaged = file.staged;
  return (
    <div className="git-file-row">
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', padding: '3px 4px', cursor: 'pointer' }}
        onClick={() => onToggleDiff(file.path)}
        title={meta.title}
      >
        <span style={{ color: 'var(--vscode-descriptionForeground)', width: '14px', flexShrink: 0 }}>
          {expandedDiff ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="truncate" title={file.path} style={{ color: 'var(--vscode-text-fg)', flex: 1 }}>{file.path}</span>
        <span style={{ fontWeight: 'bold', color: meta.color, fontSize: '11px', minWidth: '14px', textAlign: 'center' }}>
          {meta.label}
        </span>
        {/* action buttons */}
        <span style={{ display: 'flex', gap: '2px', marginLeft: '4px' }}>
          {!isStaged ? (
            <button
              title={t('gitSidebar.addToStage')}
              onClick={(e) => { e.stopPropagation(); onStage(file.path); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--diff-text-added)', padding: '1px' }}
            >
              <Plus size={12} />
            </button>
          ) : (
            <button
              title={t('gitSidebar.removeFromStage')}
              onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vscode-fg-gold)', padding: '1px' }}
            >
              <Minus size={12} />
            </button>
          )}
          <button
            title={file.status === '??' ? t('gitSidebar.discardUntracked') : t('gitSidebar.discardChanges')}
            onClick={(e) => { e.stopPropagation(); onDiscard(file.path); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vscode-errorForeground)', padding: '1px' }}
          >
            <RotateCcw size={12} />
          </button>
        </span>
      </div>
      {expandedDiff && (
        <div style={{ padding: '0 4px 6px 24px' }}>
          {loadingDiff ? (
            <div style={{ fontSize: '11px', color: 'var(--vscode-text-muted)' }}>{t('gitSidebar.loadingDiff')}</div>
          ) : (
            <DiffViewer diff={diff} />
          )}
        </div>
      )}
    </div>
  );
}

export default function GitSidebar({
  activeProject,
  gitChanges,
  fetchGitStatus,
  commitMessage,
  setCommitMessage,
  isCommitting,
  handleGitCommit,
  onStageFile,
  onStageAllFiles,
  onUnstageFile,
  onDiscardFile,
  gitRootPath,
  onPickGitRoot,
  onClearGitRoot,
  reviewMode = false,
  onAfterRestore,
}) {
  const { t } = useTranslation();
  const { showConfirm, showAlert } = useCustomDialog();
  const [activeTab, setActiveTab] = useState('changes'); // 'changes' | 'log'
  const [expandedDiffs, setExpandedDiffs] = useState({});
  const [diffs, setDiffs] = useState({});
  const [loadingDiffs, setLoadingDiffs] = useState({});
  const [expandedCommitDiffs, setExpandedCommitDiffs] = useState({});
  const [commitDiffs, setCommitDiffs] = useState({});
  const [loadingCommitDiffs, setLoadingCommitDiffs] = useState({});
  const [selectedCommitDiffFiles, setSelectedCommitDiffFiles] = useState({});
  const [restoringCommit, setRestoringCommit] = useState('');
  const [downloadingCommit, setDownloadingCommit] = useState('');
  const [commits, setCommits] = useState([]);
  const [loadingLog, setLoadingLog] = useState(false);
  const [reviewPage, setReviewPage] = useState(0);
  const [reviewHasNextPage, setReviewHasNextPage] = useState(false);

  const projectPath = activeProject?.project_path;
  // GilzaBots' agent checkpoint history ("shadow" repository, review mode) does
  // not exist in GilzaCode; only the user's repository is shown. The reviewMode
  // branches below are inactive (reviewMode defaults to false).
  const effectiveUseShadowGit = false;
  const effectiveGitRoot = gitRootPath || projectPath;
  const gitQuery = useCallback((extra = {}) => {
    const params = new URLSearchParams({ projectPath, ...extra });
    if (gitRootPath) params.set('gitRootPath', gitRootPath);
    return params.toString();
  }, [projectPath, gitRootPath]);
  const gitBody = useCallback((extra = {}) => ({
    projectPath,
    ...(gitRootPath ? { gitRootPath } : {}),
    ...extra,
  }), [projectPath, gitRootPath]);

  const fetchLog = useCallback(async () => {
    if (!projectPath) return;
    setLoadingLog(true);
    try {
      const limit = reviewMode ? REVIEW_HISTORY_PAGE_SIZE : 30;
      const offset = reviewMode ? reviewPage * REVIEW_HISTORY_PAGE_SIZE : 0;
      const res = await fetch(`/api/git/log?${gitQuery({ limit: String(limit), offset: String(offset) })}`);
      if (res.ok) {
        const d = await res.json();
        setCommits(d.commits || []);
        setReviewHasNextPage(!!d.has_more);
      }
    } catch { /* ignore */ }
    finally { setLoadingLog(false); }
  }, [projectPath, gitQuery, reviewMode, reviewPage]);

  useEffect(() => {
    if ((reviewMode || activeTab === 'log') && projectPath) fetchLog();
  }, [activeTab, projectPath, fetchLog, gitRootPath, reviewMode]);

  useEffect(() => {
    if (reviewMode) return;
    fetchGitStatus();
  }, [gitRootPath, reviewMode]);

  useEffect(() => {
    setExpandedDiffs({});
    setDiffs({});
    setExpandedCommitDiffs({});
    setCommitDiffs({});
    setLoadingCommitDiffs({});
    setSelectedCommitDiffFiles({});
  }, [projectPath, gitRootPath]);

  useEffect(() => {
    setReviewPage(0);
  }, [projectPath, gitRootPath, reviewMode]);

  const toggleDiff = async (filePath) => {
    const next = !expandedDiffs[filePath];
    setExpandedDiffs(prev => ({ ...prev, [filePath]: next }));
    if (next && !diffs[filePath]) {
      setLoadingDiffs(prev => ({ ...prev, [filePath]: true }));
      try {
        const res = await fetch(`/api/git/diff?${gitQuery({ filePath })}`);
        if (res.ok) { const d = await res.json(); setDiffs(prev => ({ ...prev, [filePath]: d.diff || '' })); }
      } catch { /* ignore */ }
      finally { setLoadingDiffs(prev => ({ ...prev, [filePath]: false })); }
    }
  };

  const refreshDiff = (filePath) => {
    setDiffs(prev => { const n = { ...prev }; delete n[filePath]; return n; });
  };

  const handleStage = async (filePath) => {
    await onStageFile(filePath);
    refreshDiff(filePath);
  };

  const handleUnstage = async (filePath) => {
    await onUnstageFile(filePath);
    refreshDiff(filePath);
  };

  const handleDiscard = async (filePath) => {
    await onDiscardFile(filePath);
    setExpandedDiffs(prev => { const n = { ...prev }; delete n[filePath]; return n; });
    refreshDiff(filePath);
  };

  const handleStageAll = async () => {
    if (!projectPath) return;
    const ok = await onStageAllFiles();
    if (ok) {
      setDiffs({});
    }
  };

  const fetchCommitDiff = useCallback(async (commitHash, endCommitHash, filePath = ALL_DIFF_FILES) => {
    const baseKey = endCommitHash ? `${commitHash}..${endCommitHash}` : commitHash;
    const cacheKey = commitDiffCacheKey(baseKey, filePath);
    if (commitDiffs[cacheKey] !== undefined || loadingCommitDiffs[cacheKey]) return;
    setLoadingCommitDiffs(prev => ({ ...prev, [cacheKey]: true }));
    try {
      const params = new URLSearchParams(endCommitHash
        ? gitQuery({ commit: commitHash, endCommit: endCommitHash })
        : gitQuery({ commit: commitHash }));
      if (filePath !== ALL_DIFF_FILES) params.set('filePath', filePath);
      const res = await fetch(`/api/git/diff?${params}`);
      if (res.ok) {
        const d = await res.json();
        setCommitDiffs(prev => ({ ...prev, [cacheKey]: d.diff || '' }));
      }
    } catch { /* ignore */ }
    finally { setLoadingCommitDiffs(prev => ({ ...prev, [cacheKey]: false })); }
  }, [commitDiffs, gitQuery, loadingCommitDiffs]);

  const toggleCommitDiff = async (commitHash, endCommitHash) => {
    const key = endCommitHash ? `${commitHash}..${endCommitHash}` : commitHash;
    const next = !expandedCommitDiffs[key];
    setExpandedCommitDiffs(prev => ({ ...prev, [key]: next }));
    if (next) fetchCommitDiff(commitHash, endCommitHash);
  };

  const selectCommitDiffFile = async (commitHash, endCommitHash, filePath) => {
    const key = endCommitHash ? `${commitHash}..${endCommitHash}` : commitHash;
    setSelectedCommitDiffFiles(prev => ({ ...prev, [key]: filePath }));
    await fetchCommitDiff(commitHash, endCommitHash, filePath);
  };

  const restoreCommit = async (commit) => {
    if (!projectPath || restoringCommit) return;
    const confirmed = await showConfirm(t('gitSidebar.restoreConfirm', { short: commit.short, message: commit.message }));
    if (!confirmed) return;
    setRestoringCommit(commit.hash);
    try {
      const res = await fetch('/api/git/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitBody({ commit: commit.hash })),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t('gitSidebar.restoreFailed'));
      }
      await fetchLog();
      fetchGitStatus();
      onAfterRestore?.(commit);
    } catch (err) {
      await showAlert(t('gitSidebar.restoreError', { error: err.message }));
    } finally {
      setRestoringCommit('');
    }
  };

  const downloadCommitArchive = async (commit) => {
    if (!projectPath || !commit?.hash || downloadingCommit) return;
    setDownloadingCommit(commit.hash);
    try {
      const res = await fetch(`/api/git/archive?${gitQuery({ commit: commit.hash })}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t('gitSidebar.downloadFailed'));
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] || `gilzabots-checkpoint-${commit.short || commit.hash.slice(0, 12)}.zip`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      await showAlert(t('gitSidebar.downloadError', { error: err.message }));
    } finally {
      setDownloadingCommit('');
    }
  };

  const hasUnstagedChanges = gitChanges.some(f => !f.staged);

  const tabStyle = (tab) => ({
    flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0',
    fontSize: '11px', fontWeight: activeTab === tab ? 'bold' : 'normal',
    color: activeTab === tab ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
    borderBottom: activeTab === tab ? '2px solid var(--vscode-active-border)' : '2px solid transparent',
  });

  if (!activeProject) return (
    <div className="vscode-sidebar-content" style={{ padding: reviewMode ? '20px' : '12px' }}>
      <div className="vscode-sidebar-title">{reviewMode ? t('gitSidebar.reviewHeader') : t('gitSidebar.header')}</div>
      <div style={{ fontSize: '12px', color: 'var(--vscode-text-muted)', fontStyle: 'italic', marginTop: '12px' }}>
        {t('gitSidebar.selectProjectForVcs')}
      </div>
    </div>
  );

  const renderReviewPagination = () => {
    if (!reviewMode || loadingLog || (commits.length === 0 && reviewPage === 0)) return null;
    return (
      <div className="git-review-pagination">
        <button
          type="button"
          className="git-review-page-button"
          title={t('gitSidebar.previousPage')}
          onClick={() => setReviewPage(page => Math.max(0, page - 1))}
          disabled={reviewPage === 0}
        >
          <ChevronLeft size={13} />
          {t('gitSidebar.previous')}
        </button>
        <div className="git-review-page-status">
          {t('gitSidebar.reviewPageStatus', { page: reviewPage + 1, count: commits.length })}
        </div>
        <button
          type="button"
          className="git-review-page-button"
          title={t('gitSidebar.nextPage')}
          onClick={() => setReviewPage(page => page + 1)}
          disabled={!reviewHasNextPage}
        >
          {t('gitSidebar.next')}
          <ChevronRight size={13} />
        </button>
      </div>
    );
  };

  function CommitDiffPanel({ commitHash, endCommitHash, wrapLines = false }) {
    const baseKey = endCommitHash ? `${commitHash}..${endCommitHash}` : commitHash;
    const selectedFile = selectedCommitDiffFiles[baseKey] || ALL_DIFF_FILES;
    const selectedKey = commitDiffCacheKey(baseKey, selectedFile);
    const fullDiff = commitDiffs[baseKey] || '';
    const currentDiff = commitDiffs[selectedKey] || '';
    const loading = !!loadingCommitDiffs[selectedKey];
    const fileOptions = parseDiffFileOptions(fullDiff);

    return (
      <>
        {fileOptions.length > 1 && (
          <div className="git-review-file-filter">
            <label htmlFor={`git-review-file-${baseKey}`}>
              {t('gitSidebar.reviewFileFilter')}
            </label>
            <select
              id={`git-review-file-${baseKey}`}
              value={selectedFile}
              onChange={(e) => selectCommitDiffFile(commitHash, endCommitHash, e.target.value)}
              className="vscode-settings-input git-review-file-select"
            >
              <option value={ALL_DIFF_FILES}>{t('gitSidebar.reviewAllFiles')}</option>
              {fileOptions.map(filePath => (
                <option key={filePath} value={filePath}>{filePath}</option>
              ))}
            </select>
          </div>
        )}
        {loading ? (
          <div style={{ fontSize: '11px', color: 'var(--vscode-text-muted)' }}>{t('gitSidebar.loadingDiff')}</div>
        ) : (
          <DiffViewer diff={currentDiff} wrapLines={wrapLines} />
        )}
      </>
    );
  }

  function AgentTurnRow({ item }) {
    const turnKey = `${item.start.hash}..${item.end.hash}`;
    const [expanded, setExpanded] = React.useState(false);
    const [undoing, setUndoing] = React.useState(false);

    const handleDiff = () => toggleCommitDiff(item.start.hash, item.end.hash);

    const handleUndo = async () => {
      if (undoing || restoringCommit) return;
      const confirmed = await showConfirm(
        t('gitSidebar.agentCheckpointUndoConfirm', { short: item.start.short })
      );
      if (!confirmed) return;
      setUndoing(true);
      setRestoringCommit(item.start.hash);
      try {
        const res = await fetch('/api/git/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gitBody({ commit: item.start.hash })),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || t('gitSidebar.restoreFailed'));
        }
        await fetchLog();
        fetchGitStatus();
        onAfterRestore?.(item.start);
      } catch (err) {
        await showAlert(t('gitSidebar.agentCheckpointUndoFailed', { error: err.message }));
      } finally {
        setUndoing(false);
        setRestoringCommit('');
      }
    };

    const isExpanded = !!expandedCommitDiffs[turnKey];

    return (
      <div className="git-review-row">
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
          {/* Expand toggle + meta */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: '130px', color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
            <button
              type="button"
              onClick={() => setExpanded(e => !e)}
              title={t('gitSidebar.agentCheckpointDetails')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vscode-descriptionForeground)', padding: '1px', display: 'flex', alignItems: 'center' }}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <Bot size={14} style={{ color: 'var(--vscode-accent, #4d9cf8)', flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: 'monospace', color: 'var(--vscode-fg-info)' }}>{item.end.short}</div>
              <div>{item.end.date}</div>
            </div>
          </div>
          {/* Label */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: 'var(--vscode-text-fg)', fontWeight: 600 }}>
              {t('gitSidebar.agentCheckpoint')}
            </div>
            <div style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '11px', marginTop: '2px' }}>
              {item.end.author}
            </div>
          </div>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button
              type="button"
              className="vscode-button secondary"
              title={isExpanded ? t('gitSidebar.collapseCommitDiff') : t('gitSidebar.showCommitDiff')}
              onClick={handleDiff}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' }}
            >
              {isExpanded ? <EyeOff size={12} /> : <Eye size={12} />}
              {isExpanded ? t('gitSidebar.collapse') : t('gitSidebar.diff')}
            </button>
            <button
              type="button"
              className="vscode-button secondary"
              title={t('gitSidebar.downloadCheckpointZip')}
              onClick={() => downloadCommitArchive(item.end)}
              disabled={!!downloadingCommit}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' }}
            >
              <Download size={12} />
              {downloadingCommit === item.end.hash ? t('gitSidebar.downloading') : t('gitSidebar.downloadZip')}
            </button>
            <button
              type="button"
              className="vscode-button"
              title={t('gitSidebar.agentCheckpointUndoTitle')}
              onClick={handleUndo}
              disabled={undoing || !!restoringCommit}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' }}
            >
              <RotateCcw size={12} />
              {undoing ? t('gitSidebar.agentCheckpointUndoing') : t('gitSidebar.agentCheckpointUndo')}
            </button>
          </div>
        </div>

        {/* Net diff (toggled by Diff button) */}
        {isExpanded && (
          <div style={{ marginTop: '8px' }}>
            <CommitDiffPanel commitHash={item.start.hash} endCommitHash={item.end.hash} wrapLines />
          </div>
        )}

        {/* Expandable details */}
        {expanded && (
          <div style={{ marginTop: '10px', paddingLeft: '20px', borderLeft: '2px solid var(--vscode-border)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Before / After */}
            <div style={{ display: 'flex', gap: '16px', fontSize: '11px' }}>
              <div>
                <span style={{ color: 'var(--vscode-descriptionForeground)' }}>{t('gitSidebar.agentCheckpointBefore')}: </span>
                <span style={{ fontFamily: 'monospace', color: 'var(--vscode-fg-info)' }}>{item.start.short}</span>
                <span style={{ color: 'var(--vscode-descriptionForeground)', marginLeft: '6px' }}>{item.start.date}</span>
                <button
                  type="button"
                  className="git-icon-button"
                  title={t('gitSidebar.downloadCheckpointZip')}
                  onClick={() => downloadCommitArchive(item.start)}
                  disabled={!!downloadingCommit}
                  style={{ marginLeft: '6px', verticalAlign: 'middle' }}
                >
                  <Download size={11} />
                </button>
              </div>
              <div>
                <span style={{ color: 'var(--vscode-descriptionForeground)' }}>{t('gitSidebar.agentCheckpointAfter')}: </span>
                <span style={{ fontFamily: 'monospace', color: 'var(--vscode-fg-info)' }}>{item.end.short}</span>
                <span style={{ color: 'var(--vscode-descriptionForeground)', marginLeft: '6px' }}>{item.end.date}</span>
                <button
                  type="button"
                  className="git-icon-button"
                  title={t('gitSidebar.downloadCheckpointZip')}
                  onClick={() => downloadCommitArchive(item.end)}
                  disabled={!!downloadingCommit}
                  style={{ marginLeft: '6px', verticalAlign: 'middle' }}
                >
                  <Download size={11} />
                </button>
              </div>
            </div>
            {/* Tool steps */}
            {item.tools.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginBottom: '4px', fontWeight: 600 }}>
                  {t('gitSidebar.agentCheckpointToolSteps')} ({item.tools.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {item.tools.map((tool, idx) => (
                    <div key={tool.hash || idx} className="git-commit-row" style={{ fontSize: '11px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontFamily: 'monospace', color: 'var(--vscode-fg-info)', minWidth: '60px' }}>{tool.short}</span>
                        <span style={{ color: 'var(--vscode-text-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tool.message}>
                          {tool.message.replace(/^Agent tool checkpoint:\s*/, '')}
                        </span>
                        <button
                          type="button"
                          className="git-icon-button"
                          title={expandedCommitDiffs[tool.hash] ? t('gitSidebar.collapseCommitDiff') : t('gitSidebar.showCommitDiff')}
                          onClick={() => toggleCommitDiff(tool.hash)}
                          style={{ flexShrink: 0 }}
                        >
                          {expandedCommitDiffs[tool.hash] ? <EyeOff size={11} /> : <Eye size={11} />}
                        </button>
                      </div>
                      {expandedCommitDiffs[tool.hash] && (
                        <div style={{ marginTop: '4px' }}>
                          <CommitDiffPanel commitHash={tool.hash} wrapLines />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const renderHistory = () => {
    const items = reviewMode ? groupAgentTurns(commits) : commits.map(c => ({ type: 'commit', commit: c }));
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: reviewMode ? '16px 20px 24px' : '12px' }}>
        {loadingLog ? (
          <div style={{ fontSize: '12px', color: 'var(--vscode-text-muted)' }}>{t('gitSidebar.loadingHistory')}</div>
        ) : commits.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--vscode-text-muted)', fontStyle: 'italic' }}>
            {reviewMode && reviewPage > 0 ? t('gitSidebar.noCommitsOnPage') : t('gitSidebar.noCommits')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: reviewMode ? '8px' : '2px' }}>
            {items.map((item, i) => {
              if (item.type === 'agent_turn') {
                return <AgentTurnRow key={`${item.start.hash}-${item.end.hash}`} item={item} />;
              }
              const c = item.commit;
              const isCommitDiffExpanded = !!expandedCommitDiffs[c.hash];
              return (
                <div key={c.hash || i} className={reviewMode ? 'git-review-row' : 'git-commit-row'}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                    <div style={{ minWidth: reviewMode ? '130px' : 'auto', color: 'var(--vscode-descriptionForeground)', fontSize: reviewMode ? '12px' : '11px' }}>
                      <div style={{ fontFamily: 'monospace', color: 'var(--vscode-fg-info)' }}>{c.short}</div>
                      <div>{c.date}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: 'var(--vscode-text-fg)', fontWeight: reviewMode ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: reviewMode ? 'normal' : 'nowrap' }} title={c.message}>
                        {c.message}
                      </div>
                      <div style={{ color: 'var(--vscode-descriptionForeground)', marginTop: '3px' }}>{c.author}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <button
                        type="button"
                        className={reviewMode ? 'vscode-button secondary' : 'git-icon-button'}
                        title={isCommitDiffExpanded ? t('gitSidebar.collapseCommitDiff') : t('gitSidebar.showCommitDiff')}
                        onClick={() => toggleCommitDiff(c.hash)}
                        style={reviewMode ? { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' } : undefined}
                      >
                        {isCommitDiffExpanded ? <EyeOff size={12} /> : <Eye size={12} />}
                        {reviewMode && (isCommitDiffExpanded ? t('gitSidebar.collapse') : t('gitSidebar.diff'))}
                      </button>
                      {reviewMode && (
                        <button
                          type="button"
                          className="vscode-button secondary"
                          title={t('gitSidebar.downloadCheckpointZip')}
                          onClick={() => downloadCommitArchive(c)}
                          disabled={!!downloadingCommit}
                          style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' }}
                        >
                          <Download size={12} />
                          {downloadingCommit === c.hash ? t('gitSidebar.downloading') : t('gitSidebar.downloadZip')}
                        </button>
                      )}
                      {(reviewMode || effectiveUseShadowGit) && (
                        <button
                          type="button"
                          className={reviewMode ? 'vscode-button' : 'git-icon-button'}
                          title={t('gitSidebar.restoreCheckpoint')}
                          onClick={() => restoreCommit(c)}
                          disabled={!!restoringCommit}
                          style={reviewMode ? { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', padding: '4px 8px' } : undefined}
                        >
                          <RotateCcw size={12} /> {reviewMode && (restoringCommit === c.hash ? t('gitSidebar.restoring') : t('gitSidebar.restore'))}
                        </button>
                      )}
                    </div>
                  </div>
                  {isCommitDiffExpanded && (
                    <div style={{ marginTop: '8px', paddingLeft: reviewMode ? '0' : '12px' }}>
                      <CommitDiffPanel commitHash={c.hash} wrapLines={reviewMode} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {renderReviewPagination()}
      </div>
    );
  };



  return (
    <div className="vscode-sidebar-content" style={{ padding: '0', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="vscode-sidebar-title" style={{ margin: 0 }}>{reviewMode ? t('gitSidebar.reviewHeader') : t('gitSidebar.header')}</div>
        <button
          onClick={() => { if (!reviewMode) fetchGitStatus(); if (reviewMode || activeTab === 'log') fetchLog(); }}
          title={t('gitSidebar.refresh')}
          className="git-icon-button"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {!reviewMode && (
      <div style={{ padding: '0 12px 8px' }}>
        {(
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px' }}>
            <div
              className="truncate"
              title={effectiveGitRoot}
              style={{ flex: 1, fontSize: '11px', color: 'var(--vscode-descriptionForeground)', background: 'var(--vscode-input-bg)', border: '1px solid var(--vscode-input-border)', borderRadius: '3px', padding: '3px 5px' }}
            >
              {effectiveGitRoot}
            </div>
            <button
              type="button"
              title={t('gitSidebar.chooseGitRoot')}
              onClick={onPickGitRoot}
              className="git-icon-button"
            >
              <FolderOpen size={13} />
            </button>
            {gitRootPath && (
              <button
                type="button"
                title={t('gitSidebar.clearGitRoot')}
                onClick={onClearGitRoot}
                className="git-icon-button"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      )}

      {reviewMode && (
        <div style={{ padding: '0 20px 10px', color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
          {t('gitSidebar.reviewSubtitle')}
        </div>
      )}


      {/* Tabs */}
      {!reviewMode && (
      <div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-border)', padding: '0 12px' }}>
        <button style={tabStyle('changes')} onClick={() => setActiveTab('changes')}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
            <GitBranch size={11} /> {t('gitSidebar.changesTab')} {gitChanges.length > 0 && `(${gitChanges.length})`}
          </span>
        </button>
        <button style={tabStyle('log')} onClick={() => setActiveTab('log')}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
            <History size={11} /> {t('gitSidebar.historyTab')}
          </span>
        </button>
      </div>
      )}

      {/* Tab: Changes */}
      {!reviewMode && activeTab === 'changes' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '12px', gap: '12px' }}>
          {/* Commit form */}
          <form onSubmit={handleGitCommit} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input
              type="text"
              placeholder={t('gitSidebar.commitPlaceholder')}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              required
              style={{ width: '100%', fontSize: '12px', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="vscode-button"
                onClick={handleStageAll}
                title={t('gitSidebar.stageAll')}
                style={{ flex: '0 0 auto', fontSize: '11px', padding: '4px 8px' }}
                disabled={!hasUnstagedChanges}
              >
                +All
              </button>
              <button
                type="submit"
                className="vscode-button"
                disabled={isCommitting || !commitMessage.trim()}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
              >
                <GitCommit size={12} />
                {isCommitting ? t('gitSidebar.committing') : t('gitSidebar.commit')}
              </button>
            </div>
          </form>

          {/* File list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {gitChanges.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--vscode-text-muted)', fontStyle: 'italic' }}>{t('gitSidebar.noChanges')}</div>
            ) : (
              <>
                <div className="vscode-sidebar-section-title" style={{ marginBottom: '6px', padding: 0 }}>
                  {t('gitSidebar.modifications', { count: gitChanges.length })}
                </div>
                {gitChanges.map((file, i) => (
                  <FileRow
                    key={i}
                    file={file}
                    projectPath={projectPath}
                    onStage={handleStage}
                    onUnstage={handleUnstage}
                    onDiscard={handleDiscard}
                    onToggleDiff={toggleDiff}
                    expandedDiff={!!expandedDiffs[file.path]}
                    diff={diffs[file.path]}
                    loadingDiff={!!loadingDiffs[file.path]}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab: Log */}
      {(reviewMode || activeTab === 'log') && renderHistory()}
    </div>
  );
}
