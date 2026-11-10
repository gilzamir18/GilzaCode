import React from 'react';
import { FolderOpen, Folder, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Modal for browsing and selecting a directory from the filesystem.
export default function DirPickerModal({ dirPicker, onNavigate, onConfirm, onClose }) {
  const { t } = useTranslation();

  if (!dirPicker) return null;

  return (
    <div
      className="vscode-modal-overlay"
      style={{ zIndex: 1100 }}
      onClick={onClose}
    >
      <div
        className="vscode-modal"
        style={{ padding: 'var(--modal-body-padding) var(--modal-gutter)', width: '480px', maxHeight: 'calc(60 * var(--ui-vh))', display: 'flex', flexDirection: 'column', gap: '10px' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title */}
        <div style={{ color: 'var(--vscode-text-fg)', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FolderOpen size={15} style={{ color: 'var(--vscode-fg-folder)' }} />
          {t('dirPickerModal.title')}
        </div>

        {/* Current path */}
        <div style={{
          background: 'var(--vscode-input-bg, #252526)',
          border: '1px solid var(--vscode-border, #3c3c3c)',
          borderRadius: '3px',
          padding: '5px 8px',
          fontSize: '12px',
          color: 'var(--vscode-text-fg, var(--vscode-fg-info))',
          fontFamily: 'monospace',
          wordBreak: 'break-all'
        }}>
          {dirPicker.current}
        </div>

        {dirPicker.error && (
          <div role="alert" style={{ color: 'var(--vscode-errorForeground, #f48771)', fontSize: '12px' }}>
            {dirPicker.error}
          </div>
        )}

        {/* Directory list */}
        <div style={{
          overflowY: 'auto',
          flex: 1,
          border: '1px solid var(--vscode-border, #3c3c3c)',
          borderRadius: '3px',
          background: 'var(--vscode-input-bg, #252526)'
        }}>
          {dirPicker.dirs.length === 0 && !dirPicker.error && (
            <div style={{ color: 'var(--vscode-descriptionForeground, var(--vscode-text-muted))', fontSize: '12px', padding: '12px', textAlign: 'center' }}>{t('dirPickerModal.noSubdirs')}</div>
          )}
          {dirPicker.dirs.map(d => (
            <div
              key={d.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 8px',
                cursor: 'pointer',
                fontSize: '12px',
                color: 'var(--vscode-text-fg)',
                borderBottom: '1px solid var(--vscode-border, #2d2d2d)'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--vscode-list-hoverBg, #2a2d2e)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => onNavigate(d.path)}
            >
              <Folder size={13} style={{ color: 'var(--vscode-fg-folder)', flexShrink: 0 }} />
              <span style={{ fontFamily: 'monospace' }}>{d.name}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            className="vscode-button"
            style={{
              background: 'transparent',
              border: '1px solid var(--vscode-border, #4c4c6c)',
              color: 'var(--vscode-text-fg, #a0a0c0)',
              fontSize: '12px'
            }}
            onClick={onClose}
          >
            {t('dirPickerModal.cancel')}
          </button>
          <button type="button" className="vscode-button" style={{ fontSize: '12px' }} onClick={onConfirm}>
            <Check size={12} /> {t('dirPickerModal.selectFolder')}
          </button>
        </div>
      </div>
    </div>
  );
}
