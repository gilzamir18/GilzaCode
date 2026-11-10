import React, { useState, useEffect, useMemo } from 'react';
import { FolderInput, Folder, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function DirTreeNode({ node, depth, selectedDir, onSelect, expanded, onToggle }) {
  const isOpen = expanded.has(node.path);
  const dirChildren = node.children;
  const isSelected = selectedDir === node.path;

  return (
    <div>
      <div
        onClick={() => onSelect(node.path)}
        className={`vscode-tree-node ${isSelected ? 'active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 4}px`, display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
          style={{ display: 'flex', alignItems: 'center', width: '14px', flexShrink: 0 }}
        >
          {dirChildren.length > 0 ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
        </span>
        <Folder size={14} style={{ color: 'var(--vscode-fg-folder)', flexShrink: 0 }} />
        <span className="truncate">{node.name}</span>
      </div>
      {isOpen && dirChildren.map(child => (
        <DirTreeNode key={child.path} node={child} depth={depth + 1} selectedDir={selectedDir} onSelect={onSelect} expanded={expanded} onToggle={onToggle} />
      ))}
    </div>
  );
}

// Modal for picking a target directory inside the active project's own workspace tree,
// used to move one or more selected files/directories via "Move to...".
export default function MoveToModal({ moveModal, files, isFileInsidePath, onConfirm, onClose }) {
  const { t } = useTranslation();
  const [selectedDir, setSelectedDir] = useState('');
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    setSelectedDir('');
    setExpanded(new Set());
  }, [moveModal]);

  const rootDirs = useMemo(() => {
    if (!moveModal) return [];
    const excludedPaths = moveModal.paths || [];
    const filterTree = (nodes) => (nodes || [])
      .filter(n => n.isDirectory)
      .filter(n => !excludedPaths.some(p => isFileInsidePath(n.path, p)))
      .map(n => ({ ...n, children: filterTree(n.children) }));
    return filterTree(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, moveModal]);

  if (!moveModal) return null;

  const toggle = (path) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

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
        <div style={{ color: 'var(--vscode-text-fg)', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FolderInput size={15} style={{ color: 'var(--vscode-fg-folder)' }} />
          {moveModal.paths && moveModal.paths.length > 1
            ? t('moveToModal.titleMulti', 'Move {{count}} items to...', { count: moveModal.paths.length })
            : t('moveToModal.title', 'Move to...')}
        </div>

        <div style={{
          overflowY: 'auto',
          flex: 1,
          border: '1px solid var(--vscode-border, #3c3c3c)',
          borderRadius: '3px',
          background: 'var(--vscode-input-bg, #252526)'
        }}>
          <div
            onClick={() => setSelectedDir('')}
            className={`vscode-tree-node ${selectedDir === '' ? 'active' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', paddingLeft: '4px' }}
          >
            <Folder size={14} style={{ color: 'var(--vscode-fg-folder)', flexShrink: 0 }} />
            <span>{t('moveToModal.projectRoot', 'Project Root')}</span>
          </div>
          {rootDirs.length === 0 && (
            <div style={{ color: 'var(--vscode-descriptionForeground, var(--vscode-text-muted))', fontSize: '12px', padding: '12px', textAlign: 'center' }}>
              {t('moveToModal.noSubdirs', 'No subdirectories')}
            </div>
          )}
          {rootDirs.map(node => (
            <DirTreeNode key={node.path} node={node} depth={1} selectedDir={selectedDir} onSelect={setSelectedDir} expanded={expanded} onToggle={toggle} />
          ))}
        </div>

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
          <button type="button" className="vscode-button" style={{ fontSize: '12px' }} onClick={() => onConfirm(selectedDir)}>
            <Check size={12} /> {t('moveToModal.confirm', 'Move here')}
          </button>
        </div>
      </div>
    </div>
  );
}
