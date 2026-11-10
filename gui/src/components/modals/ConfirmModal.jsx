import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';

// Modal displayed when the backend emits an input_request (Yes/No confirmation).
//
// This is the *tool* confirmation: one line of text and a decision, raised in
// the middle of a run the user already started. It stays modal on purpose —
// what is being approved is a command about to touch the workspace, and letting
// the user edit files underneath while it waits would change the very thing
// they are approving.
//
// Plan review is the other case and no longer comes through here: it is
// answered by reading the project, so it is a non-blocking floating window
// (`PlanReviewWindow`), routed on `markdown_content` in App.jsx.
export default function ConfirmModal({ confirmRequest, onConfirm }) {
  const { t } = useTranslation();

  if (!confirmRequest) return null;

  const buttonLabel = (key, defaultValue) => {
    const label = t(key, { defaultValue });
    return label === key ? defaultValue : label;
  };

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{
        maxWidth: '420px',
        width: '90%',
        maxHeight: 'calc(90 * var(--ui-vh))',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div className="vscode-sidebar-header" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Bell size={18} aria-hidden="true" style={{ color: 'var(--vscode-fg-gold)', flexShrink: 0 }} />
          <span className="vscode-sidebar-title" style={{ letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            {t('confirmModal.title', 'Confirm')}
          </span>
        </div>

        {/* Body */}
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <p style={{ fontSize: '14px', color: 'var(--vscode-text-fg)', lineHeight: 1.6, marginBottom: '16px', marginTop: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
            {confirmRequest.prompt}
          </p>
        </div>

        {/* Footer Buttons */}
        <div style={{ 
          display: 'flex', gap: '8px', justifyContent: 'flex-end', 
          padding: '16px 20px', borderTop: '1px solid var(--vscode-border)', 
          backgroundColor: 'var(--vscode-sidebar-bg)' 
        }}>
          {(confirmRequest.options || ['no', 'yes']).map(opt => {
            if (opt === 'cancel') {
              return (
                <button
                  key="cancel"
                  onClick={() => onConfirm('cancel')}
                  className="vscode-button"
                  style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                >
                  {buttonLabel('confirmModal.cancel', 'Cancel')}
                </button>
              );
            }
            if (opt === 'no') {
              return (
                <button
                  key="no"
                  id="confirm-no-btn"
                  onClick={() => onConfirm('no')}
                  className="vscode-button"
                  style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)' }}
                >
                  {buttonLabel('confirmModal.no', 'No')}
                </button>
              );
            }
            if (opt === 'yes') {
              return (
                <button
                  key="yes"
                  id="confirm-yes-btn"
                  onClick={() => onConfirm('yes')}
                  className="vscode-button"
                >
                  {buttonLabel('confirmModal.yes', 'Yes')}
                </button>
              );
            }
            if (opt === 'always') {
              return (
                <button
                  key="always"
                  id="confirm-always-btn"
                  onClick={() => onConfirm('always')}
                  className="vscode-button"
                  style={{ background: '#2ea043', border: '1px solid #238636', color: '#ffffff' }}
                >
                  {buttonLabel('confirmModal.always', 'Always Allow')}
                </button>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}
