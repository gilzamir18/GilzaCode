import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

export default function DeleteProjectModal({ projectToDelete, onCancel, onConfirm }) {
  const { t } = useTranslation();
  const [deleteDir, setDeleteDir] = useState(false);

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

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => { setDeleteDir(false); onCancel(); }}
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
              onConfirm(deleteDir);
              setDeleteDir(false);
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
