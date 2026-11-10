// ─────────────────────────────────────────────────────────────────────────────
// GraphicPreview
//
// Inline preview for LaTeX graphics (tikzpicture / PGFPlots). Used by both
// the RichTextEditor (one block at a time) and the LaTeX live preview
// (multiple blocks per page) through the `formatMessageContent` pipeline.
//
// Renders the source snippet by calling POST /api/latex/render-graphic,
// which compiles a minimal standalone document with tectonic and converts
// the first page to SVG via PyMuPDF. Caches results client-side and
// server-side to keep typing snappy.
//
// The component is read-only: there is no editing inside the preview. The
// caller is expected to provide a way to jump back to the original source
// (e.g. through the surrounding wrapper) when the user wants to edit.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Module-level cache so multiple GraphicPreview instances in the same page
// share results. Bounded to keep memory in check.
const graphicSvgCache = new Map();
const GRAPHIC_CACHE_MAX = 64;

function hashSource(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export default function GraphicPreview({
  source,
  projectPath = '',
  label = 'TikZ / PGFPlots',
}) {
  const { t } = useTranslation();
  const [state, setState] = useState({ status: 'idle', svg: '', log: '' });
  const debounceRef = useRef(null);
  const tokenRef = useRef(0);

  const cacheKey = `${projectPath || ''}::${hashSource(source || '')}`;

  useEffect(() => {
    tokenRef.current += 1;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (!source || !source.trim()) {
      setState({ status: 'idle', svg: '', log: '' });
      return;
    }

    const cached = graphicSvgCache.get(cacheKey);
    if (cached) {
      setState({ status: 'ok', svg: cached, log: '' });
      return;
    }

    setState({ status: 'loading', svg: '', log: '' });

    debounceRef.current = setTimeout(async () => {
      const myToken = tokenRef.current;
      try {
        const res = await fetch('/api/latex/render-graphic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            graphic: source,
            projectPath: projectPath || '',
            cacheKey,
          }),
        });
        const data = await res.json();
        if (myToken !== tokenRef.current) return;
        if (data && data.success && data.svg) {
          graphicSvgCache.set(cacheKey, data.svg);
          if (graphicSvgCache.size > GRAPHIC_CACHE_MAX) {
            const firstKey = graphicSvgCache.keys().next().value;
            graphicSvgCache.delete(firstKey);
          }
          setState({ status: 'ok', svg: data.svg, log: '' });
        } else {
          setState({ status: 'err', svg: '', log: (data && data.log) || t('graphicPreview.renderFailed') });
        }
      } catch (err) {
        if (myToken !== tokenRef.current) return;
        setState({ status: 'err', svg: '', log: String(err) });
      }
    }, 250);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [cacheKey, source, projectPath]);

  return (
    <div
      style={{
        margin: '8px 0',
        border: '1px solid var(--border-color, #3c3c3c)',
        borderRadius: '4px',
        overflow: 'hidden',
        background: 'var(--editor-bg, #1e1e1e)',
      }}
    >
      <div
        style={{
          background: 'var(--titlebar-bg, #1a1a1a)',
          padding: '2px 10px',
          fontSize: '11px',
          color: 'var(--vscode-descriptionForeground, #888)',
          borderBottom: '1px solid var(--border-color, #3c3c3c)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{label}</span>
        {state.status === 'loading' && <span>{t('graphicPreview.rendering')}</span>}
        {state.status === 'err' && <span style={{ color: 'var(--vscode-errorForeground)' }}>{t('graphicPreview.previewFailed')}</span>}
      </div>
      <div
        style={{
          padding: '12px',
          minHeight: '60px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {state.status === 'loading' && (
          <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
            {t('graphicPreview.renderingPreview')}
          </span>
        )}
        {state.status === 'err' && (
          <pre
            style={{
              margin: 0,
              fontSize: '11px',
              color: 'var(--vscode-errorForeground)',
              maxHeight: '120px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              width: '100%',
            }}
            title={state.log}
          >
            {t('graphicPreview.previewUnavailable', { log: state.log.split('\n').slice(-3).join('\n').trim() })}
          </pre>
        )}
        {state.status === 'ok' && (
          <div
            // SVG produced by tectonic from the user's own source. The block
            // is rendered read-only in the preview pipeline, so no user input
            // is rendered as HTML here.
            dangerouslySetInnerHTML={{ __html: state.svg }}
            style={{ maxWidth: '100%' }}
          />
        )}
      </div>
    </div>
  );
}
