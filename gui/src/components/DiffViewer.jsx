import React from 'react';
import { useTranslation } from 'react-i18next';

// A unified diff, coloured by line (added, removed, hunk header, file header).
// Shared by the Git sidebar's repository views and its agent history.
export default function DiffViewer({ diff, wrapLines = false }) {
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
