import React from 'react';
import { X, FolderOpen, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Creating a project: a name and the folder it lives in. The markup is
// GilzaBots' "General" tab; the model, execution-mode and agent-parameter tabs
// are gone because Claude Code is the agent.
export default function NewProjectModal({
  onClose,
  onSubmit,
  newProjName, setNewProjName,
  newProjPath, setNewProjPath,
  newProjError,
  onOpenDirPicker,
}) {
  const { t } = useTranslation();

  const isWindows = navigator.userAgent.toLowerCase().includes('windows');
  const dynamicPathHint = isWindows ? t('newProjectModal.pathHintWindows', 'Ex: C:\\\\Projects') : t('newProjectModal.pathHintUnix', 'Ex: /home/user/projects');

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal">
        <div className="vscode-modal-header" style={{ borderBottom: 'none' }}>
          <span className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)' }}>{t('newProjectModal.title')}</span>
          <button type="button" className="vscode-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X size={14} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="vscode-modal-content flex flex-col overflow-y-auto flex-1" style={{ gap: '12px' }}>
          {/* Project name */}
          <div className="flex flex-col" style={{ gap: '4px' }}>
            <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.projectName')}</label>
            <input
              type="text"
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              placeholder={t('newProjectModal.projectNamePlaceholder')}
              required
            />
          </div>

          {/* Project path */}
          <div className="flex flex-col" style={{ gap: '4px' }}>
            <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('newProjectModal.projectPath')}</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                value={newProjPath}
                onChange={(e) => setNewProjPath(e.target.value)}
                placeholder={dynamicPathHint}
                required
                style={{ flex: 1 }}
              />
              <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                onClick={() => onOpenDirPicker('new', newProjPath || '~')}>
                <FolderOpen size={14} />
              </button>
            </div>
          </div>

          {newProjError && (
            <div style={{ color: 'var(--vscode-errorForeground)', fontSize: '11px', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
              <AlertTriangle size={12} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: '4px' }} />{newProjError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '12px', borderTop: '1px solid var(--vscode-border)', marginTop: '4px' }}>
            <button type="button" onClick={onClose} className="vscode-button" style={{ background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}>
              {t('newProjectModal.cancel')}
            </button>
            <button type="submit" className="vscode-button">{t('newProjectModal.register')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
