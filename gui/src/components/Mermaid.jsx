import React, { useEffect, useRef, useState } from 'react';

// Loaded on the first diagram, not with the application: mermaid and the
// libraries it pulls in were most of the JavaScript parsed at every launch,
// for chats that rarely draw a diagram. Rendering was already asynchronous.
let mermaidReady = null;
const loadMermaid = () => {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      // Initialize mermaid configuration once
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        suppressErrorRendering: true,
      });
      return mermaid;
    });
    // A failed load is retried by the next diagram instead of failing them all.
    mermaidReady.catch(() => { mermaidReady = null; });
  }
  return mermaidReady;
};

export default function Mermaid({ chart }) {
  const [svg, setSvg] = useState('');
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const uniqueId = `mermaid-${Math.floor(Math.random() * 1000000)}`;

    const renderChart = async () => {
      try {
        setRenderFailed(false);
        const cleanChart = chart.trim();
        if (!cleanChart) {
          if (isMounted) setRenderFailed(true);
          return;
        }
        const mermaid = await loadMermaid();
        if (!isMounted) return;
        const { svg: renderedSvg } = await mermaid.render(uniqueId, cleanChart);
        if (isMounted) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        // Silently fall back to code block — mermaid errors are rarely useful to the user
        console.warn('Mermaid rendering failed, falling back to code block:', err.message);
        if (isMounted) {
          setRenderFailed(true);
        }
      }
    };

    renderChart();

    return () => {
      isMounted = false;
    };
  }, [chart]);

  // Graceful fallback: show the raw mermaid source as a readable code block
  if (renderFailed) {
    return (
      <div style={{ margin: '8px 0', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border-color, #3c3c3c)' }}>
        <div style={{ background: 'var(--titlebar-bg, #1a1a1a)', padding: '2px 10px', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', borderBottom: '1px solid var(--border-color, #3c3c3c)' }}>
          mermaid
        </div>
        <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', overflowX: 'auto', fontSize: '12px', lineHeight: '1.5', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <code>{chart.trim()}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div style={{
        color: 'var(--vscode-descriptionForeground, #888)',
        fontSize: '12px',
        padding: '8px'
      }}>
        Generating diagram...
      </div>
    );
  }

  return (
    <div 
      dangerouslySetInnerHTML={{ __html: svg }} 
      style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        margin: '12px 0',
        padding: '10px',
        background: 'var(--editor-bg, #1e1e1e)',
        borderRadius: '4px',
        border: '1px solid var(--border-color, #3c3c3c)',
        overflowX: 'auto'
      }} 
    />
  );
}
