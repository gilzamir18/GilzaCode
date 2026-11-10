import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

// `cloudLink` comes from /api/cloud/link: when the project has a copy in the
// cloud, the dialog offers to delete that too. Off by default — removing a
// project from this computer is not a reason to remove it everywhere.
export default function DeleteProjectModal({ projectToDelete, cloudLink, onCancel, onConfirm }) {
  const { t } = useTranslation();
  const [deleteDir, setDeleteDir] = useState(false);
  const [deleteCloud, setDeleteCloud] = useState(false);

  if (!projectToDelete) return null;

  return (
    <div className="vscode-modal-overlay" style={{ zIndex: 1000 }}>
      <div className="vscode-modal" style={{
        padding: '28px 32px',
        maxWidth: '420px',
        width: '90%',
        borderRadius: '12px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <AlertTriangle size={20} aria-hidden="true" style={{ color: 'var(--vscode-fg-gold)', flexShrink: 0 }} />
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--vscode-descriptionForeground, #a0a0c0)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('deleteProjectModal.title', 'Remove Project')}
          </span>
        </div>

        <p style={{ fontSize: '14px', color: 'var(--vscode-text-fg, #e0e0f0)', lineHeight: 1.6, marginBottom: '16px', margin: '0 0 16px 0' }}>
          <Trans
            i18nKey="deleteProjectModal.confirmMessage"
            values={{ projectName: projectToDelete }}
            defaults="Are you sure you want to remove the project <1>'{{projectName}}'</1>?"
            components={[<span />, <strong />]}
          />
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--vscode-descriptionForeground, #a0a0c0)', marginBottom: '24px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={deleteDir}
            onChange={(e) => setDeleteDir(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          {t('deleteProjectModal.deleteDir', 'Also delete the directory associated with the project')}
        </label>

        {cloudLink?.linked && (
          <div style={{ marginTop: '-12px', marginBottom: '24px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--vscode-descriptionForeground, #a0a0c0)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={deleteCloud}
                onChange={(e) => setDeleteCloud(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              {t('deleteProjectModal.deleteCloud', {
                defaultValue: 'Also delete the copy in the cloud ({{provider}}: {{folder}})',
                provider: cloudLink.provider_name || cloudLink.provider,
                folder: cloudLink.remote_folder,
              })}
            </label>
            {deleteCloud && (
              <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground, #a0a0c0)', lineHeight: 1.5, margin: '6px 0 0 24px' }}>
                {cloudLink.recoverable
                  ? t('deleteProjectModal.deleteCloudTrash', 'The folder goes to the trash, where it can be restored for a limited time.')
                  : t('deleteProjectModal.deleteCloudPermanent', 'This storage has no trash: the folder is deleted permanently.')}
                {' '}
                {t('deleteProjectModal.deleteCloudOtherMachines', 'Other computers that sync this project stop syncing it and keep their own copy.')}
              </p>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => { setDeleteDir(false); setDeleteCloud(false); onCancel(); }}
            className="vscode-button"
            style={{
              background: 'transparent', border: '1px solid var(--vscode-border, #4c4c6c)',
              color: 'var(--vscode-text-fg, #a0a0c0)', cursor: 'pointer',
              fontSize: '13px', fontWeight: 600, padding: '8px 20px', borderRadius: '8px',
              transition: 'all 0.15s',
            }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={() => {
              onConfirm(deleteDir, !!cloudLink?.linked && deleteCloud);
              setDeleteDir(false);
              setDeleteCloud(false);
            }}
            style={{
              padding: '8px 24px', borderRadius: '8px', border: 'none',
              background: 'linear-gradient(135deg, #cc3333, #a30000)',
              color: '#fff', cursor: 'pointer',
              fontSize: '13px', fontWeight: 700,
              boxShadow: '0 4px 16px rgba(204,51,51,0.25)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.target.style.background = 'linear-gradient(135deg, #f03030, #cc3333)'; }}
            onMouseLeave={e => { e.target.style.background = 'linear-gradient(135deg, #cc3333, #a30000)'; }}
          >
            {t('deleteProjectModal.removeBtn', 'Remove')}
          </button>
        </div>
      </div>
    </div>
  );
}
