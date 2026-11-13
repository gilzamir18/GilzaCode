import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, File, RefreshCw, Regex, WholeWord } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Typing waits this long before searching; Enter searches at once.
const SEARCH_DEBOUNCE_MS = 400;

const splitPath = (path) => {
  const normalized = String(path).replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1
    ? { name: normalized, dir: '' }
    : { name: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
};

function OptionToggle({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className="vscode-sidebar-action-btn"
      style={{
        padding: '2px',
        borderRadius: '3px',
        border: `1px solid ${active ? 'var(--vscode-focusBorder, var(--vscode-accent))' : 'transparent'}`,
        background: active ? 'var(--vscode-active-item)' : 'transparent',
        color: 'var(--vscode-text-fg)',
        cursor: 'pointer',
        display: 'flex',
      }}
    >
      {children}
    </button>
  );
}

// Left sidebar — Search tab: find text in the project's text files (Markdown,
// LaTeX, code...) through /api/files/search, and open a match in the editor.
// The query and its results live in App, so they survive switching tabs.
export default function SearchSidebar({
  activeProject,
  showHiddenFiles,
  searchState,
  setSearchState,
  onOpenMatch,
  focusToken,
}) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const requestIdRef = useRef(0);
  const [isSearching, setIsSearching] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState(() => new Set());
  const projectPath = activeProject?.project_path || null;
  const { query, caseSensitive, wholeWord, regex } = searchState;
  // Results from another project are never shown against this one.
  const response = searchState.projectPath === projectPath ? searchState.response : null;
  const errorText = searchState.projectPath === projectPath ? searchState.error : '';

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  const runSearch = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!projectPath || !query) {
      setIsSearching(false);
      setSearchState(prev => ({ ...prev, projectPath, response: null, error: '' }));
      return;
    }
    setIsSearching(true);
    const params = new URLSearchParams({
      projectPath,
      query,
      caseSensitive: String(caseSensitive),
      wholeWord: String(wholeWord),
      regex: String(regex),
      showHiddenFiles: String(Boolean(showHiddenFiles)),
    });
    try {
      const res = await fetch(`/api/files/search?${params}`);
      const data = await res.json().catch(() => ({}));
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        setSearchState(prev => ({ ...prev, projectPath, response: null, error: data.error || `HTTP ${res.status}` }));
      } else {
        setCollapsedFiles(new Set());
        setSearchState(prev => ({ ...prev, projectPath, response: data, error: '' }));
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setSearchState(prev => ({ ...prev, projectPath, response: null, error: err.message }));
    } finally {
      if (requestId === requestIdRef.current) setIsSearching(false);
    }
  }, [projectPath, query, caseSensitive, wholeWord, regex, showHiddenFiles, setSearchState]);

  // Search as the user types or changes an option, after a pause.
  useEffect(() => {
    const timer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [runSearch]);

  const setOption = (key) => setSearchState(prev => ({ ...prev, [key]: !prev[key] }));
  const toggleFile = (path) => setCollapsedFiles(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const results = response?.results || [];

  let summary = '';
  if (errorText) {
    // The error line replaces the summary.
  } else if (isSearching && !response) summary = t('searchSidebar.searching', 'Searching...');
  else if (response && response.matchCount === 0) summary = t('searchSidebar.noResults', 'No results found.');
  else if (response) {
    summary = t('searchSidebar.summary', '{{matches}} results in {{files}} files', {
      matches: response.matchCount,
      files: results.length,
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="vscode-sidebar-header">
        <span className="vscode-sidebar-title">{t('searchSidebar.header', 'Search')}</span>
        <button
          onClick={runSearch}
          disabled={!projectPath || !query}
          className="vscode-sidebar-action-btn"
          style={{ padding: '2px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)' }}
          title={t('searchSidebar.refresh', 'Search again')}
        >
          <RefreshCw size={12} className={isSearching ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="vscode-sidebar-section" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', position: 'relative' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            disabled={!projectPath}
            onChange={(e) => setSearchState(prev => ({ ...prev, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
              else if (e.key === 'Escape' && query) { e.preventDefault(); setSearchState(prev => ({ ...prev, query: '' })); }
            }}
            placeholder={projectPath
              ? t('searchSidebar.placeholder', 'Search in text files')
              : t('searchSidebar.noProject', 'Open a project to search its files')}
            aria-label={t('searchSidebar.placeholder', 'Search in text files')}
            className="vscode-settings-input"
            style={{
              flex: 1,
              minWidth: 0,
              height: '26px',
              padding: '4px 6px',
              fontSize: '12px',
              border: `1px solid ${errorText ? 'var(--vscode-errorForeground)' : 'var(--vscode-border)'}`,
              background: 'var(--vscode-input-bg)',
              color: 'var(--vscode-input-fg, var(--vscode-text-fg))',
              borderRadius: '2px',
              outline: 'none',
            }}
          />
          <OptionToggle active={caseSensitive} onClick={() => setOption('caseSensitive')} title={t('searchSidebar.matchCase', 'Match case')}>
            <CaseSensitive size={14} />
          </OptionToggle>
          <OptionToggle active={wholeWord} onClick={() => setOption('wholeWord')} title={t('searchSidebar.wholeWord', 'Match whole word')}>
            <WholeWord size={14} />
          </OptionToggle>
          <OptionToggle active={regex} onClick={() => setOption('regex')} title={t('searchSidebar.regex', 'Use regular expression')}>
            <Regex size={14} />
          </OptionToggle>
        </div>
        {errorText && (
          <div role="alert" style={{ fontSize: '11px', color: 'var(--vscode-errorForeground)' }}>{errorText}</div>
        )}
        {summary && (
          <div style={{ fontSize: '11px', color: 'var(--vscode-text-muted)' }}>{summary}</div>
        )}
        {response?.truncated && (
          <div style={{ fontSize: '11px', color: 'var(--vscode-fg-gold)' }}>
            {t('searchSidebar.truncated', 'Only the first {{count}} results are shown. Refine the search to see the rest.', { count: response.matchCount })}
          </div>
        )}
        {response?.skippedLarge > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--vscode-text-muted)' }}>
            {t('searchSidebar.skippedLarge', '{{count}} large files were not searched.', { count: response.skippedLarge })}
          </div>
        )}
      </div>

      <div className="vscode-sidebar-content" style={{ opacity: isSearching && response ? 0.6 : 1 }}>
        {results.map(file => {
          const { name, dir } = splitPath(file.path);
          const isCollapsed = collapsedFiles.has(file.path);
          return (
            <div key={file.path}>
              <div
                className="vscode-tree-node"
                onClick={() => toggleFile(file.path)}
                title={file.path}
                style={{ padding: '3px 4px' }}
              >
                {isCollapsed ? <ChevronRight size={14} style={{ flexShrink: 0 }} /> : <ChevronDown size={14} style={{ flexShrink: 0 }} />}
                <File size={14} style={{ color: 'var(--vscode-text-muted)', flexShrink: 0 }} />
                <span className="truncate" style={{ flexShrink: 1, minWidth: 0 }}>{name}</span>
                {dir && <span className="truncate" style={{ fontSize: '11px', color: 'var(--vscode-text-muted)', flex: 1, minWidth: 0 }}>{dir}</span>}
                <span style={{
                  marginLeft: 'auto',
                  flexShrink: 0,
                  fontSize: '10px',
                  padding: '0 5px',
                  borderRadius: '8px',
                  background: 'var(--vscode-hover-item)',
                  color: 'var(--vscode-text-fg)',
                }}>
                  {file.matches.length}
                </span>
              </div>
              {!isCollapsed && file.matches.map((match, index) => (
                <div
                  key={`${match.line}:${match.column}:${index}`}
                  className="vscode-tree-node"
                  onClick={() => onOpenMatch(file.path, match)}
                  title={t('searchSidebar.lineTitle', 'Line {{line}}, column {{column}}', { line: match.line, column: match.column })}
                  style={{ padding: '2px 4px 2px 34px', fontSize: '12px', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  <span style={{ color: 'var(--vscode-text-muted)' }}>{match.before}</span>
                  <mark style={{
                    background: 'var(--search-match-bg, rgba(234, 92, 0, 0.35))',
                    color: 'inherit',
                    borderRadius: '2px',
                  }}>
                    {match.match}
                  </mark>
                  <span style={{ color: 'var(--vscode-text-muted)' }}>{match.after}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
