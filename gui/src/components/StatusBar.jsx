import React from 'react';
import { Info, CaseSensitive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { COUNT_MODE_AUTO } from '../utils/textStats';

// Bottom status bar (VSCode-style footer).
export default function StatusBar({ activeProject, textStats }) {
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
