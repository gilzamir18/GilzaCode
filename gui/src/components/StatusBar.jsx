import React from 'react';
import { Info, CaseSensitive, Cloud, CloudOff, RefreshCw, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { COUNT_MODE_AUTO } from '../utils/textStats';

// Bottom status bar (VSCode-style footer).
// The status bar has room for a file name, not a path.
function baseName(relPath) {
  const parts = String(relPath || '').split('/');
  return parts[parts.length - 1] || '';
}

// Bottom status bar (VSCode-style footer).
export default function StatusBar({ activeProject, textStats, cloudStatus, onOpenCloudSync }) {
  const { t, i18n } = useTranslation();

  const formatNumber = (value) => Number(value || 0).toLocaleString(i18n.language);

  const modeLabel = textStats ? t(`statusBar.countMode.${textStats.mode}`) : '';
  // The label shows the effective mode; "(auto)" tells the user it was
  // detected from the file type rather than pinned by hand.
  const modeSuffix = textStats && textStats.modeOverride === COUNT_MODE_AUTO
    ? t('statusBar.countModeAutoSuffix')
    : '';

  // The selection replaces the document count while text is selected, the way
  // a word processor does — that is the number the user just asked for.
  const shownStats = textStats?.selection || textStats;

  const countTooltip = textStats ? [
    t('statusBar.countTooltipMode', { mode: `${modeLabel}${modeSuffix}` }),
    t('statusBar.countTooltipWords', { value: formatNumber(textStats.words) }),
    t('statusBar.countTooltipChars', { value: formatNumber(textStats.characters) }),
    t('statusBar.countTooltipCharsNoSpaces', { value: formatNumber(textStats.charactersNoSpaces) }),
    t('statusBar.countTooltipLines', { value: formatNumber(textStats.lines) }),
    t('statusBar.countTooltipRaw', { value: formatNumber(textStats.rawCharacters) }),
    textStats.selection
      ? t('statusBar.countTooltipSelection', {
        words: formatNumber(textStats.selection.words),
        characters: formatNumber(textStats.selection.characters),
      })
      : null,
    '',
    t('statusBar.countTooltipHint'),
  ].filter(item => item !== null).join('\n') : '';

  // Cloud sync indicator. An error outranks a running pass: a sync that keeps
  // failing is the one thing here the user has to act on.
  const cloudError = cloudStatus?.last_error || cloudStatus?.auth_error || '';
  const cloudSyncing = !!cloudStatus?.syncing;
  const cloudIcon = cloudSyncing
    ? <RefreshCw size={12} className="animate-spin" />
    : cloudError
      ? <AlertTriangle size={12} style={{ color: 'var(--vscode-fg-warning)' }} />
      : cloudStatus?.connected || cloudStatus?.settings?.provider === 'local_folder'
        ? <Cloud size={12} />
        : <CloudOff size={12} />;
  // While a pass runs, the label names the file being moved and how far along
  // the pass is: "Syncing…" alone left the user unable to tell a working sync
  // from a stuck one.
  const progress = cloudStatus?.progress || null;
  const progressActive = cloudSyncing || !!progress?.active;
  const currentFile = progress?.current_path ? baseName(progress.current_path) : '';
  const counter = progress?.total
    ? `${Math.min(progress.examined || 0, progress.total)}/${progress.total}`
    : '';
  const syncingLabel = currentFile
    ? t('statusBar.cloudSyncingFile', {
      defaultValue: 'Syncing {{file}} ({{counter}})',
      file: currentFile,
      counter: counter || '…',
    })
    : t('statusBar.cloudSyncing', 'Syncing…');
  const conflictCount = cloudStatus?.last_outcome?.report?.conflicts?.length || 0;
  const cloudLabel = progressActive
    ? syncingLabel
    : cloudError
      ? t('statusBar.cloudError', 'Sync issue')
      : conflictCount
        ? t('statusBar.cloudConflicts', {
          defaultValue: '{{count}} conflict(s)',
          count: conflictCount,
        })
        : cloudStatus?.last_sync_at
          ? t('statusBar.cloudSynced', 'Synced')
          : t('statusBar.cloudPending', 'Not synced yet');
  const cloudTooltip = [
    t('statusBar.cloudTooltipProvider', {
      defaultValue: 'Cloud sync: {{provider}}',
      provider: cloudStatus?.settings?.provider || '—',
    }),
    cloudStatus?.account
      ? t('statusBar.cloudTooltipAccount', { defaultValue: 'Account: {{account}}', account: cloudStatus.account })
      : null,
    cloudStatus?.last_sync_at
      ? t('statusBar.cloudTooltipLast', {
        defaultValue: 'Last pass: {{when}}',
        when: new Date(cloudStatus.last_sync_at).toLocaleString(),
      })
      : null,
    progress?.current_path
      ? t('statusBar.cloudTooltipCurrent', {
        defaultValue: 'Now: {{action}} {{path}}',
        action: progress.current_action || 'sync',
        path: progress.current_path,
      })
      : null,
    !progressActive && progress?.counts && Object.keys(progress.counts).length
      ? t('statusBar.cloudTooltipMoved', {
        defaultValue: 'Last pass moved: {{summary}}',
        summary: Object.entries(progress.counts)
          .map(([action, count]) => `${action} ${count}`)
          .join(', '),
      })
      : null,
    conflictCount
      ? t('statusBar.cloudTooltipConflicts', {
        defaultValue: '{{count}} file(s) need a decision — click to resolve',
        count: conflictCount,
      })
      : null,
    cloudError || null,
  ].filter(Boolean).join('\n');

  return (
    <footer className="vscode-statusbar">
      <div className="flex items-center" style={{ gap: '16px' }}>
        <div className="flex items-center" style={{ gap: '6px' }}>
          <Info size={11} />
          <span style={{ fontWeight: 'bold' }}>
            {activeProject
              ? t('statusBar.workspace', { name: activeProject.project_name || activeProject.name })
              : t('statusBar.noWorkspace')}
          </span>
        </div>
        {cloudStatus?.settings?.enabled && (
          <button
            type="button"
            className="vscode-statusbar-item"
            onClick={onOpenCloudSync}
            title={cloudTooltip}
            aria-label={cloudTooltip}
          >
            {cloudIcon}
            <span>{cloudLabel}</span>
          </button>
        )}
      </div>

      <div className="flex items-center" style={{ gap: '12px' }}>
        {textStats && (
          <button
            type="button"
            className="vscode-statusbar-item"
            onClick={textStats.onCycleMode}
            title={countTooltip}
            aria-label={countTooltip}
          >
            <CaseSensitive size={12} />
            <span>
              {textStats.selection
                ? t('statusBar.countSelection', {
                  words: formatNumber(shownStats.words),
                  characters: formatNumber(shownStats.characters),
                })
                : t('statusBar.count', {
                  words: formatNumber(shownStats.words),
                  characters: formatNumber(shownStats.characters),
                })}
            </span>
            <span style={{ opacity: 0.85 }}>{modeLabel}</span>
          </button>
        )}
        <span>UTF-8</span>
        <span>LF</span>
      </div>
    </footer>
  );
}
