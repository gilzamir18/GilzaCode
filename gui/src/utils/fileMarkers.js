// The two per-file markers of the editor tabs and the workspace tree. They
// answer different questions and are kept apart on purpose:
//
// - Unsaved (` *`, the convention every editor uses): the buffer differs from
//   what was last read from or written to disk. Never compared with git HEAD —
//   that is the diff view's baseline, and against it a saved file, or any file
//   of a project without a repository, would stay "dirty" forever.
// - Changed by the agent (a separate badge): the file differs between the start
//   and the end of an agent turn, as reported by the turn's shadow-git
//   checkpoint (`checkpoint_finalized.changed_files`). It stays until the user
//   opens the file.

import { normalizeTreePath, treePathContains } from './inlineCreate.js';

/** Key under which a project-relative path is stored in a marker set. */
export const markerPathKey = (path) => normalizeTreePath(path).replace(/^\.\//, '');

/**
 * Open text files whose buffer differs from their last known disk content.
 * A file without a buffer or without a disk baseline is not unsaved: nothing
 * was edited, or nothing was ever read to compare against.
 */
export function unsavedFilePaths({
  openFiles,
  fileContents,
  activeFile,
  activeContent,
  diskContents,
  isBinary = () => false,
}) {
  return (openFiles || []).filter((filePath) => {
    if (isBinary(filePath)) return false;
    const current = filePath === activeFile ? activeContent : fileContents?.[filePath];
    const disk = diskContents?.[filePath];
    return current !== undefined && disk !== undefined && current !== disk;
  });
}

/** A new set with `paths` added; the same set when nothing is new. */
export function withAgentChangedFiles(current, paths) {
  const keys = (paths || []).map(markerPathKey).filter(Boolean);
  if (keys.every((key) => current.has(key))) return current;
  const next = new Set(current);
  for (const key of keys) next.add(key);
  return next;
}

/** A new set without `path`; the same set when it was not marked. */
export function withoutAgentChangedFile(current, path) {
  const key = markerPathKey(path);
  if (!current.has(key)) return current;
  const next = new Set(current);
  next.delete(key);
  return next;
}

/** Re-key marks under `oldPath` (a file or a directory) after a rename or move. */
export function renameAgentChangedFiles(current, oldPath, newPath) {
  const oldKey = markerPathKey(oldPath);
  const newKey = markerPathKey(newPath);
  let changed = false;
  const next = new Set();
  for (const key of current) {
    if (treePathContains(oldKey, key)) {
      next.add(newKey + key.slice(oldKey.length));
      changed = true;
    } else {
      next.add(key);
    }
  }
  return changed ? next : current;
}

/** Drop marks on `path` and, for a directory, everything inside it. */
export function removeAgentChangedFiles(current, path) {
  const key = markerPathKey(path);
  const next = new Set([...current].filter((marked) => !treePathContains(key, marked)));
  return next.size === current.size ? current : next;
}

/**
 * Whether a tree entry carries the agent mark: a file when it is marked, a
 * directory when anything inside it is — a collapsed folder would otherwise
 * hide the change.
 */
export function hasAgentChanges(current, path, isDirectory) {
  if (!current || current.size === 0) return false;
  const key = markerPathKey(path);
  if (!isDirectory) return current.has(key);
  for (const marked of current) {
    if (marked !== key && treePathContains(key, marked)) return true;
  }
  return false;
}
