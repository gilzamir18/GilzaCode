import React, { useRef, useLayoutEffect } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { Plus, FolderPlus, Upload, Edit2, Trash2, Copy, ClipboardPaste, ExternalLink, FolderInput } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Floating right-click context menu for the file explorer.
export default function ContextMenu({
  contextMenu,
  rightClickedNode,
  handleCreateNewFile,
  handleCreateNewDir,
  handleImportFile,
  handleRenameNode,
  handleDeleteNode,
  handleCopyNode,
  handlePasteNode,
  handleOpenInSystem,
  handleSetMainFile,
  handleMoveToNode,
  clipboardNode,
}) {
  const { t } = useTranslation();
  const menuRef = useRef(null);

  useLayoutEffect(() => {
    if (menuRef.current && contextMenu) {
      // The comparisons stay in viewport pixels — a rect and innerHeight are
      // both measured there — but the corrected position is written back as a
      // CSS length inside the zoomed app, so it has to cross the boundary.
      const scale = readUiScale();
      const rect = menuRef.current.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        menuRef.current.style.top = `${viewportPxToApp(window.innerHeight - rect.height - 5, scale)}px`;
      }
      if (rect.right > window.innerWidth) {
        menuRef.current.style.left = `${viewportPxToApp(window.innerWidth - rect.width - 5, scale)}px`;
      }
    }
  }, [contextMenu]);

  if (!contextMenu) return null;

  const parentPath = rightClickedNode
    ? (rightClickedNode.isDirectory
      ? rightClickedNode.path
      : rightClickedNode.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/'))
    : '';

  const isTexFile = rightClickedNode && !rightClickedNode.isDirectory && rightClickedNode.name.endsWith('.tex');

  return (
    <div
      ref={menuRef}
      className="vscode-context-menu"
      style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
    >
      <div
        className="vscode-context-menu-item"
        onClick={() => handleCreateNewFile(parentPath)}
      >
        <Plus size={13} style={{ color: 'var(--vscode-accent)' }} />
        <span>{t('contextMenu.newFile')}</span>
      </div>
      <div
        className="vscode-context-menu-item"
        onClick={() => handleCreateNewDir(parentPath)}
      >
        <FolderPlus size={13} style={{ color: 'var(--vscode-accent)' }} />
        <span>{t('contextMenu.newDir')}</span>
      </div>
      <div
        className="vscode-context-menu-item"
        onClick={() => handleImportFile(parentPath)}
      >
        <Upload size={13} style={{ color: 'var(--vscode-accent)' }} />
        <span>{t('contextMenu.importFile', 'Import File...')}</span>
      </div>
      {rightClickedNode && (
        <>
          {isTexFile && handleSetMainFile && (
            <div
              className="vscode-context-menu-item"
              onClick={() => handleSetMainFile(rightClickedNode)}
            >
              <ExternalLink size={13} style={{ color: 'var(--vscode-accent)' }} />
              <span>{t('contextMenu.setMainFile', 'Definir como Main File')}</span>
            </div>
          )}
          <div
            className="vscode-context-menu-item"
            onClick={() => handleOpenInSystem(rightClickedNode)}
          >
            <ExternalLink size={13} style={{ color: 'var(--vscode-accent)' }} />
            <span>{t('contextMenu.openInSystem', 'Abrir com app padrão')}</span>
          </div>
          <div
            className="vscode-context-menu-item"
            onClick={() => handleCopyNode(rightClickedNode)}
          >
            <Copy size={13} style={{ color: 'var(--vscode-text-muted)' }} />
            <span>{t('contextMenu.copy', 'Copiar')}</span>
          </div>
          <div
            className="vscode-context-menu-item"
            onClick={() => handleRenameNode(rightClickedNode)}
          >
            <Edit2 size={13} style={{ color: 'var(--vscode-fg-gold)' }} />
            <span>{t('contextMenu.rename')}</span>
          </div>
          <div
            className="vscode-context-menu-item"
            onClick={() => handleMoveToNode(rightClickedNode)}
          >
            <FolderInput size={13} style={{ color: 'var(--vscode-accent)' }} />
            <span>{t('contextMenu.moveTo', 'Move to...')}</span>
          </div>
          <div
            className="vscode-context-menu-item"
            onClick={() => handleDeleteNode(rightClickedNode)}
          >
            <Trash2 size={13} style={{ color: 'var(--vscode-errorForeground)' }} />
            <span>{t('contextMenu.delete')}</span>
          </div>
        </>
      )}
      {clipboardNode && (
        <div
          className="vscode-context-menu-item"
          onClick={() => handlePasteNode(parentPath)}
        >
          <ClipboardPaste size={13} style={{ color: 'var(--vscode-accent)' }} />
          <span>{t('contextMenu.paste', 'Colar')}</span>
        </div>
      )}
    </div>
  );
}
