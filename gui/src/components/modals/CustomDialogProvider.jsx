import React, { createContext, useContext, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, HelpCircle, Type, X } from 'lucide-react';

const CustomDialogContext = createContext(null);

export function CustomDialogProvider({ children }) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(null);
  const dialogRef = useRef(null);

  // There is one dialog slot. Opening another while one is showing settles the
  // first as dismissed, so its caller is not left awaiting a promise forever.
  const openDialog = (next) => {
    const previous = dialogRef.current;
    dialogRef.current = next;
    setDialog(next);
    if (previous) previous.resolve(dismissedValue(previous.type));
  };

  // Define show dialog methods
  const showAlert = (message, title = '') => {
    return new Promise((resolve) => {
      openDialog({
        type: 'alert',
        title: title || t('alertModal.title', 'Notification'),
        message,
        resolve,
      });
    });
  };

  // `options.okLabel` / `options.cancelLabel` name the two choices. With
  // `options.destructive`, OK is the choice that loses something: the focus
  // starts on Cancel and Enter does not stand for OK.
  const showConfirm = (message, title = '', options = {}) => {
    return new Promise((resolve) => {
      openDialog({
        type: 'confirm',
        title: title || t('confirmModal.title', 'Confirmation'),
        message,
        okLabel: options.okLabel,
        cancelLabel: options.cancelLabel,
        destructive: Boolean(options.destructive),
        resolve,
      });
    });
  };

  const showPrompt = (message, defaultValue = '', title = '') => {
    return new Promise((resolve) => {
      setInputValue(defaultValue);
      openDialog({
        type: 'prompt',
        title: title || t('askModal.title', 'Input Required'),
        message,
        defaultValue,
        resolve,
      });
    });
  };

  // Keyboard navigation
  useEffect(() => {
    if (!dialog) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleCancel();
      } else if (e.key === 'Enter' && dialog.type !== 'prompt' && !dialog.destructive) {
        // For prompt, enter key inside input handles submission
        handleOk();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dialog, inputValue]);

  // Focus input when prompt opens
  useEffect(() => {
    if (dialog && dialog.type === 'prompt') {
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  }, [dialog]);

  const handleOk = () => {
    if (!dialog) return;
    const { resolve, type } = dialog;
    dialogRef.current = null;
    setDialog(null);
    if (type === 'prompt') {
      resolve(inputValue);
    } else if (type === 'confirm') {
      resolve(true);
    } else {
      resolve(undefined);
    }
  };

  const handleCancel = () => {
    if (!dialog) return;
    const { resolve, type } = dialog;
    dialogRef.current = null;
    setDialog(null);
    resolve(dismissedValue(type));
  };

  return (
    <CustomDialogContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
      {children}
      {dialog && (
        <div className="vscode-modal-overlay" style={{ zIndex: 9999 }} role="presentation" onMouseDown={handleCancel}>
          <div 
            className="vscode-modal" 
            role="alertdialog" 
            aria-modal="true" 
            onMouseDown={(e) => e.stopPropagation()} 
            style={{ 
              maxWidth: '460px', 
              width: '90%',
              background: 'var(--vscode-bg)',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {/* Header */}
            <div className="vscode-modal-header">
              <span className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)', fontWeight: 600 }}>{dialog.title}</span>
              <button 
                type="button" 
                className="vscode-bottom-panel-clear-btn" 
                onClick={handleCancel} 
                aria-label={t('alertModal.close', 'Close')}
                style={{ cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>

            {/* Body */}
            <div className="vscode-modal-content flex items-start gap-4">
              {dialog.type === 'alert' && <Info size={28} style={{ flex: '0 0 auto', color: 'var(--vscode-accent, #007acc)' }} />}
              {dialog.type === 'confirm' && <HelpCircle size={28} style={{ flex: '0 0 auto', color: 'var(--vscode-accent, #007acc)' }} />}
              {dialog.type === 'prompt' && <Type size={28} style={{ flex: '0 0 auto', color: 'var(--vscode-accent, #007acc)' }} />}
              
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {dialog.message}
                </div>
                
                {dialog.type === 'prompt' && (
                  <form onSubmit={(e) => { e.preventDefault(); handleOk(); }}>
                    <input
                      ref={inputRef}
                      type="text"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '4px',
                        border: '1px solid var(--vscode-input-border, var(--vscode-border))',
                        background: 'var(--vscode-input-bg)',
                        color: 'var(--vscode-input-fg, var(--vscode-text-fg))',
                        fontSize: '13px',
                        outline: 'none',
                        marginTop: '4px'
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleOk();
                        }
                      }}
                    />
                  </form>
                )}
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="vscode-modal-footer">
              {dialog.type === 'alert' && (
                <button type="button" className="vscode-button" onClick={handleOk} autoFocus style={{ minWidth: '80px' }}>
                  {t('alertModal.ok', 'OK')}
                </button>
              )}
              {dialog.type === 'confirm' && (
                <>
                  <button 
                    type="button" 
                    className="vscode-button" 
                    onClick={handleCancel}
                    autoFocus={dialog.destructive}
                    style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)', minWidth: '80px' }}
                  >
                    {dialog.cancelLabel || t('confirmModal.cancel', 'Cancel')}
                  </button>
                  <button type="button" className="vscode-button" onClick={handleOk} autoFocus={!dialog.destructive} style={{ minWidth: '80px' }}>
                    {dialog.okLabel || t('confirmModal.yes', 'OK')}
                  </button>
                </>
              )}
              {dialog.type === 'prompt' && (
                <>
                  <button 
                    type="button" 
                    className="vscode-button" 
                    onClick={handleCancel}
                    style={{ background: 'transparent', border: '1px solid var(--vscode-border)', color: 'var(--vscode-text-fg)', minWidth: '80px' }}
                  >
                    {t('confirmModal.cancel', 'Cancel')}
                  </button>
                  <button type="button" className="vscode-button" onClick={handleOk} style={{ minWidth: '80px' }}>
                    {t('confirmModal.yes', 'OK')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </CustomDialogContext.Provider>
  );
}

function dismissedValue(type) {
  if (type === 'confirm') return false;
  if (type === 'prompt') return null;
  return undefined;
}

export function useCustomDialog() {
  const context = useContext(CustomDialogContext);
  if (!context) {
    throw new Error('useCustomDialog must be used within a CustomDialogProvider');
  }
  return context;
}
