// Inline creation of files and directories in the workspace tree. The tree row only collects a name; these helpers decide which path that
// name stands for and which directories must be expanded to show the row.

const toSlashes = (value) => String(value ?? '').replace(/\\/g, '/');

export const normalizeTreePath = (value) => toSlashes(value).replace(/\/+$/g, '');

export const isSameTreePath = (left, right) => normalizeTreePath(left) === normalizeTreePath(right);

/** Whether `dirPath` is `targetPath` or one of its ancestors. */
export const treePathContains = (dirPath, targetPath) => {
  const dir = normalizeTreePath(dirPath);
  const target = normalizeTreePath(targetPath);
  if (!dir) return false;
  return target === dir || target.startsWith(`${dir}/`);
};

/**
 * What a key does in the tree's name field: `'submit'`, `'cancel'` or `null`.
 *
 * Enter confirms, and so do Tab and Shift+Tab: leaving the field with the
 * keyboard is the user answering it, unlike the programmatic focus changes the
 * row deliberately ignores. Without this, Tab moved focus out while the row
 * stayed open, and the next Enter pressed whichever control had received focus.
 * Escape cancels.
 */
export const inlineCreateKeyAction = ({ key, ctrlKey = false, altKey = false, metaKey = false }) => {
  if (key === 'Enter') return 'submit';
  if (key === 'Tab' && !ctrlKey && !altKey && !metaKey) return 'submit';
  if (key === 'Escape') return 'cancel';
  return null;
};

/**
 * Resolve the name typed in the tree into a project-relative path.
 *
 * Returns `{ path }` for a valid name, `{ cancelled: true }` for an empty one
 * (nothing is created), or `{ error: 'invalid' }` for an absolute path or a name
 * with empty, "." or ".." segments. Nested names such as `a/b` are allowed.
 */
export const resolveInlineCreatePath = ({ parentPath = '', name }) => {
  const trimmed = toSlashes(name).trim();
  if (!trimmed) return { cancelled: true };
  if (trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed)) return { error: 'invalid' };

  const segments = trimmed.replace(/\/+$/g, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { error: 'invalid' };
  }

  const relative = segments.join('/');
  const parent = normalizeTreePath(parentPath);
  return { path: parent ? `${parent}/${relative}` : relative };
};
