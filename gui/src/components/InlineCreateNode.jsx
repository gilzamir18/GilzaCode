import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, File, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { inlineCreateKeyAction } from '../utils/inlineCreate';

// Provisional tree row used to create a file or directory in place. Enter, Tab
// or Shift+Tab creates (see `inlineCreateKeyAction`). Escape or a pointer press
// outside the row cancels.
// Losing focus by itself does nothing: the IDE moves focus programmatically
// (the editor focuses a file it has just opened), and treating that as a
// commit would create an entry the user never confirmed. The row simply stays
// open until the user answers it.
// `onSubmit` resolves to an error message to show under the row, or to a falsy
// value once the entry was created (the parent then removes the row).
export default function InlineCreateNode({ kind, onSubmit, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const rowRef = useRef(null);
  const inputRef = useRef(null);
  const busyRef = useRef(false);
  const settledRef = useRef(false);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const cancel = () => {
    if (settledRef.current || busyRef.current) return;
    settledRef.current = true;
    onCancelRef.current();
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
  }, []);

  // A press anywhere outside the row is the user leaving it: cancel.
  useEffect(() => {
    const handlePointerDown = (event) => {
      if (rowRef.current && !rowRef.current.contains(event.target)) cancel();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (settledRef.current || busyRef.current) return;
    if (!name.trim()) {
      cancel();
      return;
    }
    busyRef.current = true;
    let failure;
    try {
      failure = await onSubmit(name);
    } finally {
      busyRef.current = false;
    }
    if (failure) {
      setError(failure);
      inputRef.current?.focus();
      return;
    }
    settledRef.current = true;
  };

  const handleKeyDown = (e) => {
    e.stopPropagation();
    const action = inlineCreateKeyAction(e);
    if (action === 'submit') {
      // Also keeps Tab from moving focus: a rejected name leaves the row open
      // with its error, and the caret has to still be in the field.
      e.preventDefault();
      submit();
    } else if (action === 'cancel') {
      e.preventDefault();
      cancel();
    }
  };

  const label = {
    file: t('explorerSidebar.newFileName', 'New file name'),
    dir: t('explorerSidebar.newDirName', 'New directory name'),
  }[kind];

  const iconStyle = { flexShrink: 0 };
  const icon = kind === 'dir'
    ? <><ChevronRight size={14} style={iconStyle} /><Folder size={14} style={{ ...iconStyle, color: 'var(--vscode-fg-folder)' }} /></>
    : <File size={14} style={{ ...iconStyle, color: 'var(--vscode-text-muted)' }} />;

  return (
    <div
      ref={rowRef}
      className="inline-create-node"
      onClick={(e) => { e.stopPropagation(); inputRef.current?.focus(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="vscode-tree-node">
        {icon}
        <input
          ref={inputRef}
          type="text"
          value={name}
          aria-label={label}
          aria-invalid={Boolean(error)}
          spellCheck={false}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          onKeyDown={handleKeyDown}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{
            background: 'var(--vscode-input-bg, #1e1e1e)',
            color: 'var(--vscode-input-fg, var(--vscode-text-fg))',
            border: `1px solid ${error ? 'var(--vscode-errorForeground, #f48771)' : 'var(--vscode-focusBorder, #007acc)'}`,
            borderRadius: '2px',
            outline: 'none',
            fontSize: '12px',
            padding: '0 4px',
            lineHeight: '18px',
            height: '20px',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />
      </div>
      {error && <div role="alert" className="inline-create-error">{error}</div>}
    </div>
  );
}
