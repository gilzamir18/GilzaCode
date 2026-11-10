import React, { useRef, useEffect } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTerminal } from '../hooks/useTerminal';

export default function TerminalInstance({
  termId,
  activeProject,
  activeBottomTab,
  bottomPanelHeight,
  isTerminalCollapsed,
  theme,
  isActive,
  onMount,
  fontSize,
  uiScale,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  redrawPromptOnShow = true,
  onStreamClosed,
  connectionKey = 0,
}) {
  const { t } = useTranslation();
  const terminalRef = useRef(null);
  const terminalInstanceRef = useRef(null);
  const fitAddonRef = useRef(null);
  const eventSourceRef = useRef(null);

  const { isScrolledUp, scrollToBottom } = useTerminal({
    activeProject,
    terminalRef,
    terminalInstanceRef,
    fitAddonRef,
    eventSourceRef,
    activeBottomTab,
    bottomPanelHeight,
    isTerminalCollapsed,
    theme,
    termId,
    isActive,
    fontSize,
    uiScale,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    redrawPromptOnShow,
    onStreamClosed,
    connectionKey,
  });

  useEffect(() => {
    if (terminalInstanceRef.current && onMount) {
      onMount(terminalInstanceRef.current);
    }
  }, [terminalInstanceRef.current]);

  return (
    // Absolute so the xterm screen's own pixel height never feeds back into the
    // box FitAddon measures: an in-flow wrapper lets the terminal keep whatever
    // row count it already had, spill past the panel and hide the prompt.
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: isActive ? 'block' : 'none',
        padding: '4px',
        overflow: 'hidden'
      }}
    >
      <div ref={terminalRef} className="xterm-coordinate-space" />
      {isScrolledUp && (
        <button
          onClick={scrollToBottom}
          title={t('bottomPanel.terminalScrollToPrompt', 'Back to the prompt')}
          style={{
            position: 'absolute',
            right: '18px',
            bottom: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            fontSize: '11px',
            borderRadius: '12px',
            border: '1px solid var(--vscode-border)',
            background: 'var(--vscode-editor-bg)',
            color: 'var(--vscode-text-fg)',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
            zIndex: 5
          }}
        >
          <ArrowDownToLine size={12} />
          <span>{t('bottomPanel.terminalScrollToPrompt', 'Back to the prompt')}</span>
        </button>
      )}
    </div>
  );
}
