// Multi-selection in the workspace tree: Ctrl+A, and the paths a bulk action
// (delete, move, drag) acts on.

import { treePathContains } from './inlineCreate.js';

/** Every file and directory path in the tree, depth-first, in tree order. */
export const collectTreePaths = (nodes) => {
  const paths = [];
  const visit = (list) => {
    for (const node of list || []) {
      paths.push(node.path);
      if (node.isDirectory) visit(node.children);
    }
  };
  visit(nodes);
  return paths;
};

/**
 * The selected paths without those inside another selected directory.
 *
 * Deleting or moving a directory already takes its contents along, so acting on
 * a child afterwards would fail on a path that no longer exists. Ctrl+A selects
 * a directory together with everything inside it, which makes this the common
 * case rather than an edge one.
 */
export const outermostPaths = (paths) => {
  const unique = Array.from(new Set(paths));
  return unique.filter(path => !unique.some(other => other !== path && treePathContains(other, path)));
};

/**
 * Whether the tree's keydown should select everything: Ctrl+A (Cmd+A), matched
 * on the physical key too, and never while typing in a field of the tree (the
 * rename and inline-create inputs keep the text-field meaning of Ctrl+A).
 */
export const isSelectAllKey = (event) => {
  const isCtrl = event.ctrlKey || event.metaKey;
  if (!isCtrl || event.shiftKey || event.altKey) return false;
  if (!(event.key === 'a' || event.key === 'A' || event.code === 'KeyA')) return false;
  const tag = String(event.target?.tagName || '').toUpperCase();
  return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable);
};
