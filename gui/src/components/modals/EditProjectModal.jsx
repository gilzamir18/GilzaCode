import React from 'react';
import { X, Settings, Check, FolderOpen, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Project settings: name, folder, LaTeX main file and compile-on-save, Git root.
// The markup is GilzaBots' "General" tab; the model, worker and prompt-prefix
// tabs are gone because Claude Code is the agent.
export default function EditProjectModal({
  editingProject,
  setEditingProject,
  onClose,
  onSubmit,
  editProjError,
  onOpenDirPicker,
}) {
  const { t } = useTranslation();

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal" style={{ maxWidth: '520px', width: '92%' }}>
        {/* Header */}
        <div className="vscode-modal-header" style={{ borderBottom: 'none' }}>
          <span className="vscode-sidebar-title" style={{ color: 'var(--vscode-text-fg)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={14} style={{ color: 'var(--vscode-accent)' }} />
            {t('editProjectModal.title', { name: editingProject.project_name || editingProject.name })}
          </span>
          <button type="button" className="vscode-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X size={14} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="vscode-modal-content flex flex-col overflow-y-auto flex-1" style={{ gap: '14px' }}>

              {/* Internal key (read-only) */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.internalId')}</label>
                <input type="text" value={editingProject.name} readOnly style={{ opacity: 0.5, cursor: 'not-allowed' }} />
              </div>

              {/* Display name */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.displayName')}</label>
                <input
                  type="text"
                  value={editingProject.project_name}
                  onChange={e => setEditingProject(p => ({ ...p, project_name: e.target.value }))}
                  required
                  placeholder={t('editProjectModal.projectNamePlaceholder')}
                />
              </div>

              {/* Project path */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.projectPath')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={editingProject.project_path}
                    onChange={e => setEditingProject(p => ({ ...p, project_path: e.target.value }))}
                    placeholder={t('editProjectModal.projectPathPlaceholder')}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => onOpenDirPicker('edit', editingProject.project_path || '~')}>
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>

              {/* Main File */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.mainFile')}</label>
                <input
                  type="text"
                  className="vscode-settings-input"
                  value={editingProject.main_file || ''}
                  onChange={e => setEditingProject(p => ({ ...p, main_file: e.target.value }))}
                  placeholder={t('editProjectModal.mainFilePlaceholder')}
                  style={{ flex: 1 }}
                />
              </div>

              <div className="flex flex-col" style={{ gap: '8px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.latexCompileOnSave')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--vscode-text-fg)', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="radio"
                    name="compile-on-save-mode"
                    checked={editingProject.compile_on_save_partial !== true && editingProject.compile_on_save_full !== true}
                    onChange={() => setEditingProject(p => ({
                      ...p,
                      compile_on_save_partial: false,
                      compile_on_save_full: false,
                    }))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{t('editProjectModal.compileOnSaveDisabled')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--vscode-text-fg)', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="radio"
                    name="compile-on-save-mode"
                    checked={editingProject.compile_on_save_partial === true && editingProject.compile_on_save_full !== true}
                    onChange={() => setEditingProject(p => ({
                      ...p,
                      compile_on_save_partial: true,
                      compile_on_save_full: false,
                    }))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{t('editProjectModal.compileOnSavePartial')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--vscode-text-fg)', fontSize: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="radio"
                    name="compile-on-save-mode"
                    checked={editingProject.compile_on_save_full === true}
                    onChange={() => setEditingProject(p => ({
                      ...p,
                      compile_on_save_partial: false,
                      compile_on_save_full: true,
                    }))}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{t('editProjectModal.compileOnSaveFull')}</span>
                </label>
              </div>

              {/* User Git root */}
              <div className="flex flex-col" style={{ gap: '4px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('editProjectModal.gitRoot')}</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    className="vscode-settings-input"
                    value={editingProject.git_root_path || ''}
                    onChange={e => setEditingProject(p => ({ ...p, git_root_path: e.target.value }))}
                    placeholder={t('editProjectModal.gitRootPlaceholder')}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => onOpenDirPicker('edit-git-root', editingProject.git_root_path || editingProject.project_path || '~')}>
                    <FolderOpen size={14} />
                  </button>
                  <button type="button" className="vscode-button" style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => setEditingProject(p => ({ ...p, git_root_path: '' }))}>
                    {t('editProjectModal.clear')}
                  </button>
                </div>
              </div>

          {editProjError && (
            <div style={{ color: 'var(--vscode-errorForeground)', fontSize: '11px', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
              <AlertTriangle size={12} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: '4px' }} />{editProjError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', paddingTop: '12px', borderTop: '1px solid var(--vscode-border)', marginTop: '4px' }}>
            <button type="button" onClick={onClose} className="vscode-button" style={{ background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}>
              {t('editProjectModal.cancel')}
            </button>
            <button type="submit" className="vscode-button">
              <Check size={12} />
              {t('editProjectModal.saveChanges')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
