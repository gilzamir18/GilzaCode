import { useCallback, useRef, useState, useEffect } from 'react';
import { AlertCircle, Trash, Maximize2, Minimize2, ChevronUp, ChevronDown, Plus, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTextContextMenu } from '../hooks/useTextContextMenu.js';
import TextContextMenu from './TextContextMenu.jsx';
import TerminalInstance from './TerminalInstance.jsx';
import { getPreference, setPreference } from '../utils/preferences';
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
  clampTerminalFontSize,
} from '../hooks/useTerminal';

// Bottom panel with Output / Problems / Terminal tabs.
export default function BottomPanel({
  activeBottomTab,
  setActiveBottomTab,
  isTerminalCollapsed,
  setIsTerminalCollapsed,
  terminalLogs,
  setTerminalLogs,
  problems,
  setProblems,
  bottomPanelHeight,
  activeProject,
  terminalRef,
  terminalInstanceRef,
  logEndRef,
  startResizing,
  isBottomMaximized,
  onToggleMaximizeBottom,
  theme,
  uiScale,
  // The studio layout gives the panel a grid cell of its own, so it fills that
  // cell and the row is resized by the layout's handle instead of the panel's.
  fillContainer,
}) {
  const { t } = useTranslation();
  const contentRef = useRef(null);
  const logsContainerRef = useRef(null);
  const logScrollFrameRef = useRef(null);
  const terminalInstancesRef = useRef({});
  const [terminals, setTerminals] = useState(['main-1']);
  const [activeTermId, setActiveTermId] = useState('main-1');
  const [termCounter, setTermCounter] = useState(1);
  const { menu, onContextMenu, handleCopy, handlePaste, handleSelectAll } = useTextContextMenu();
  const [autoScroll, setAutoScroll] = useState(true);
  // One font size shared by every terminal in the panel: a per-instance size
  // would leave the hidden tabs behind and change under the user on switching.
  // This tunes the terminal on top of the global interface scale rather than
  // replacing it — see utils/uiScale.js.
  const [terminalFontSize, setTerminalFontSize] = useState(() =>
    clampTerminalFontSize(getPreference(TERMINAL_FONT_SIZE_STORAGE_KEY, TERMINAL_FONT_SIZE_DEFAULT)));

  const changeTerminalFontSize = useCallback((next) => {
    setTerminalFontSize((prev) => {
      const clamped = clampTerminalFontSize(typeof next === 'function' ? next(prev) : next);
      setPreference(TERMINAL_FONT_SIZE_STORAGE_KEY, clamped);
      return clamped;
    });
  }, []);

  const zoomTerminalIn = useCallback(() => changeTerminalFontSize((prev) => prev + 1), [changeTerminalFontSize]);
  const zoomTerminalOut = useCallback(() => changeTerminalFontSize((prev) => prev - 1), [changeTerminalFontSize]);
  const resetTerminalZoom = useCallback(() => changeTerminalFontSize(TERMINAL_FONT_SIZE_DEFAULT), [changeTerminalFontSize]);

  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    // Consider "at bottom" if within 30px of the bottom
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
    setAutoScroll(isAtBottom);
  };

  useEffect(() => {
    if (!autoScroll || !logEndRef?.current || logScrollFrameRef.current !== null) return;

    logScrollFrameRef.current = requestAnimationFrame(() => {
      logScrollFrameRef.current = null;
      logEndRef.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
    });
  }, [terminalLogs, autoScroll, logEndRef]);

  useEffect(() => () => {
    if (logScrollFrameRef.current !== null) {
      cancelAnimationFrame(logScrollFrameRef.current);
    }
  }, []);

  const selectTab = (tab) => {
    setActiveBottomTab(tab);
    if (isTerminalCollapsed) setIsTerminalCollapsed(false);
  };

  const clearTitle = activeBottomTab === 'output'
    ? t('bottomPanel.clearOutput')
    : t('bottomPanel.clearProblems');

  return (
    <>
      <TextContextMenu
        menu={menu}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onSelectAll={
          activeBottomTab === 'terminal'
            ? () => {
                const term = terminalInstancesRef.current[activeTermId];
                close();
                if (term) {
                  term.selectAll();
                  setTimeout(() => term.focus(), 50);
                }
              }
            : () => handleSelectAll(contentRef)
        }
      />
      {/* Vertical resize handle */}
      {!fillContainer && !isTerminalCollapsed && !isBottomMaximized && (
        <div
          className="vscode-resizer-vertical"
          onMouseDown={(e) => startResizing(e, 'bottom')}
        />
      )}

      <div
        className="vscode-bottom-panel"
        style={fillContainer
          ? { height: '100%', minHeight: 0 }
          : { height: isTerminalCollapsed ? '30px' : isBottomMaximized ? '100%' : `${bottomPanelHeight}px` }}
      >
        {/* Tab header */}
        <div className="vscode-bottom-tabs">
          <div className="vscode-bottom-tab-list">
            {['output', 'problems', 'terminal'].map((tab) => (
              <span
                key={tab}
                className={`vscode-bottom-tab ${activeBottomTab === tab ? 'active' : ''}`}
                onClick={() => selectTab(tab)}
              >
                {tab === 'output' && t('bottomPanel.outputTab')}
                {tab === 'problems' && (
                  <>
                    {t('bottomPanel.problemsTab')}{' '}
                    {problems.length > 0 && (
                      <span style={{ marginLeft: '4px', background: 'var(--vscode-errorForeground)', color: 'var(--vscode-bg)', borderRadius: '10px', padding: '0 6px', fontSize: '11px', fontWeight: 'bold' }}>
                        {problems.length}
                      </span>
                    )}
                  </>
                )}
                {tab === 'terminal' && t('bottomPanel.terminalTab')}
              </span>
            ))}
          </div>

          <div className="flex items-center" style={{ gap: '8px' }}>
            {(activeBottomTab === 'output' || activeBottomTab === 'problems') && (
              <button
                onClick={() => {
                  if (activeBottomTab === 'output') {
                    setTerminalLogs([]);
                  } else if (activeBottomTab === 'problems') {
                    setProblems([]);
                  }
                }}
                className="vscode-bottom-panel-clear-btn"
                title={clearTitle}
              >
                <Trash size={12} />
                <span>{t('bottomPanel.clear')}</span>
              </button>
            )}
            {activeBottomTab === 'terminal' && !isTerminalCollapsed && (
              <div className="flex items-center" style={{ gap: '2px' }}>
                <button
                  onClick={zoomTerminalOut}
                  disabled={terminalFontSize <= TERMINAL_FONT_SIZE_MIN}
                  className="vscode-bottom-panel-clear-btn"
                  title={t('bottomPanel.terminalZoomOut', 'Decrease terminal font size (Ctrl+-)')}
                  style={{ opacity: terminalFontSize <= TERMINAL_FONT_SIZE_MIN ? 0.4 : 1 }}
                >
                  <ZoomOut size={12} />
                </button>
                <button
                  onClick={resetTerminalZoom}
                  className="vscode-bottom-panel-clear-btn"
                  title={t('bottomPanel.terminalZoomReset', 'Reset terminal font size (Ctrl+0)')}
                  style={{ minWidth: '34px', justifyContent: 'center' }}
                >
                  {terminalFontSize}px
                </button>
                <button
                  onClick={zoomTerminalIn}
                  disabled={terminalFontSize >= TERMINAL_FONT_SIZE_MAX}
                  className="vscode-bottom-panel-clear-btn"
                  title={t('bottomPanel.terminalZoomIn', 'Increase terminal font size (Ctrl++)')}
                  style={{ opacity: terminalFontSize >= TERMINAL_FONT_SIZE_MAX ? 0.4 : 1 }}
                >
                  <ZoomIn size={12} />
                </button>
              </div>
            )}
            <button
              onClick={() => {
                if (isBottomMaximized) {
                  onToggleMaximizeBottom();
                } else {
                  setIsTerminalCollapsed(!isTerminalCollapsed);
                }
              }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-subtle)' }}
              title={isTerminalCollapsed ? t('bottomPanel.expandPanel') : isBottomMaximized ? t('bottomPanel.restorePanel') : t('bottomPanel.collapsePanel')}
            >
              {isTerminalCollapsed ? <ChevronUp size={14} /> : isBottomMaximized ? <Minimize2 size={12} /> : <ChevronDown size={14} />}
            </button>
            {!isTerminalCollapsed && !isBottomMaximized && (
              <button
                onClick={onToggleMaximizeBottom}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-subtle)' }}
                title={t('bottomPanel.maximizePanel')}
              >
                <Maximize2 size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Panel content — always mounted so xterm is never destroyed on collapse */}
        <div
          ref={contentRef}
          style={{ display: isTerminalCollapsed ? 'none' : 'block', height: 'calc(100% - 30px)', width: '100%' }}
          onContextMenu={onContextMenu}
        >

            {/* Output tab */}
            {activeBottomTab === 'output' && (
              <div 
                className="vscode-logs" 
                style={{ height: '100%', overflowY: 'auto', padding: '8px' }}
                ref={logsContainerRef}
                onScroll={handleScroll}
              >
                {terminalLogs.filter(log => !['thought', 'reflection'].includes(log.type)).length === 0 ? (
                  <div style={{ color: 'var(--vscode-text-muted)', fontStyle: 'italic' }}>
                    {t('bottomPanel.noLogs')}
                  </div>
                ) : (
                  terminalLogs
                    .filter(log => !['thought', 'reflection'].includes(log.type))
                    .map((log, i) => {
                      let colorStyle = { color: 'var(--vscode-text-fg)' };
                      let label = 'SYSTEM';
                      let bgColor = 'transparent';
                      let borderColor = 'transparent';

                      if (log.type === 'error') { 
                        colorStyle = { color: 'var(--vscode-errorForeground)', fontWeight: 'bold' }; 
                        label = 'ERROR'; 
                        bgColor = 'rgba(244, 135, 113, 0.08)';
                        borderColor = 'var(--vscode-errorForeground)';
                      }
                      else if (log.type === 'info') { 
                        colorStyle = { color: 'var(--vscode-fg-link)' }; 
                        label = 'INFO'; 
                      }
                      else if (log.type === 'tool_call') { 
                        colorStyle = { color: 'var(--vscode-textPreformat-foreground)' }; 
                        label = 'TOOL'; 
                        bgColor = 'rgba(215, 186, 125, 0.08)';
                        borderColor = 'var(--vscode-textPreformat-foreground)';
                      }
                      else if (log.type === 'tool_result') { 
                        colorStyle = { color: 'var(--vscode-fg-success)' }; 
                        label = 'RESULT'; 
                        bgColor = 'rgba(137, 212, 165, 0.08)';
                        borderColor = 'var(--vscode-fg-success)';
                      }

                      return (
                        <div key={i} style={{ 
                          padding: '6px 8px',
                          marginBottom: '6px', 
                          wordBreak: 'break-word',
                          backgroundColor: bgColor,
                          borderLeft: `3px solid ${borderColor}`,
                          borderRadius: '2px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', fontSize: '11px', opacity: 0.8 }}>
                            <span style={{ color: 'var(--vscode-text-muted)', marginRight: '6px' }}>[{log.timestamp}]</span>
                            <span style={{ fontWeight: 'bold', marginRight: '6px', color: colorStyle.color }}>[{label}]</span>
                            {log.agent && <span style={{ color: 'var(--vscode-fg-info)', fontWeight: 'bold' }}>@{log.agent}</span>}
                          </div>
                          <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace', fontSize: '12px', color: 'var(--vscode-text-fg)' }}>
                            {log.message}
                          </div>
                        </div>
                      );
                  })
                )}
                <div ref={logEndRef} />
              </div>
            )}

            {/* Problems tab */}
            {activeBottomTab === 'problems' && (
              <div className="vscode-problems-list" style={{ padding: '8px', overflowY: 'auto', height: '100%', color: 'var(--vscode-text-fg)', fontFamily: 'Consolas, monospace', fontSize: '12px' }}>
                {problems.length === 0 ? (
                  <div style={{ color: 'var(--vscode-text-muted)', fontStyle: 'italic', padding: '8px' }}>{t('bottomPanel.noProblems')}</div>
                ) : (
                  problems.map((prob) => (
                    <div key={prob.id} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', borderBottom: '1px solid var(--vscode-border)', padding: '6px 0' }}>
                      <AlertCircle size={14} style={{ color: 'var(--vscode-errorForeground)', flexShrink: 0, marginTop: '2px' }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '2px' }}>
                          <div style={{ fontWeight: 'bold', color: 'var(--vscode-errorForeground)' }}>
                            [{prob.timestamp}] {t('bottomPanel.errorIn', { tool: prob.tool })}
                          </div>
                        </div>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'var(--vscode-text-fg)', fontSize: '12px', fontFamily: 'inherit' }}>
                          {prob.message}
                        </pre>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}



            {/* Terminal tab */}
            <div style={{ display: activeBottomTab === 'terminal' ? 'flex' : 'none', flexDirection: 'column', height: '100%', background: 'var(--vscode-terminal-bg)', overflow: 'hidden' }}>
              {!activeProject ? (
                <div style={{ color: 'var(--vscode-text-muted)', fontStyle: 'italic', padding: '16px' }}>
                  {t('bottomPanel.setProjectForTerminal')}
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '2px 8px', background: 'var(--vscode-editor-bg)', borderBottom: '1px solid var(--vscode-border)', gap: '8px', flexShrink: 0 }}>
                    <select
                      value={activeTermId}
                      onChange={e => setActiveTermId(e.target.value)}
                      style={{ background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', padding: '2px 4px', fontSize: '12px', minWidth: '100px' }}
                    >
                      {terminals.map(id => (
                        <option key={id} value={id}>Terminal {id.split('-')[1]}</option>
                      ))}
                    </select>
                    <button
                      className="vscode-button"
                      style={{ padding: '2px 6px', fontSize: '12px', background: 'transparent', color: 'var(--vscode-foreground)' }}
                      onClick={() => {
                        if (terminals.length >= 3) return;
                        const nextId = termCounter + 1;
                        setTermCounter(nextId);
                        const newTerm = `main-${nextId}`;
                        
                        // Notify backend to start terminal immediately
                        fetch('/api/terminal/start', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ term_id: newTerm, projectPath: activeProject.project_path }),
                        }).catch(e => console.error(e));
                        
                        setTerminals([...terminals, newTerm]);
                        setActiveTermId(newTerm);
                      }}
                      title="New Terminal"
                      disabled={terminals.length >= 3}
                    >
                      +
                    </button>
                    {terminals.length > 1 && (
                      <button
                        className="vscode-button"
                        style={{ padding: '2px 6px', background: 'transparent', color: 'var(--vscode-errorForeground)' }}
                        onClick={() => {
                          const newTerms = terminals.filter(t => t !== activeTermId);
                          setTerminals(newTerms);
                          setActiveTermId(newTerms[newTerms.length - 1]);
                          delete terminalInstancesRef.current[activeTermId];
                        }}
                        title="Close Terminal"
                      >
                        <Trash size={12} />
                      </button>
                    )}
                  </div>
                  {/* `minHeight: 0` is load-bearing: without it this flex item keeps its
                      default `min-height: auto`, so it can never shrink below the pixel
                      height xterm gives its own screen element. FitAddon measures this
                      box, so the terminal would keep proposing the row count it already
                      had, overflow the panel, and hide the prompt below the clipped edge
                      with no scrollbar to reach it. */}
                  <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
                    {terminals.map(id => (
                      <TerminalInstance
                        key={id}
                        termId={id}
                        activeProject={activeProject}
                        activeBottomTab={activeBottomTab}
                        bottomPanelHeight={bottomPanelHeight}
                        isTerminalCollapsed={isTerminalCollapsed}
                        theme={theme}
                        isActive={id === activeTermId}
                        onMount={(term) => terminalInstancesRef.current[id] = term}
                        fontSize={terminalFontSize}
                        uiScale={uiScale}
                        onZoomIn={zoomTerminalIn}
                        onZoomOut={zoomTerminalOut}
                        onZoomReset={resetTerminalZoom}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
      </div>
    </>
  );
}
