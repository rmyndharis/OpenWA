import * as path from 'path';

/**
 * Returns true if `target` resolves to a location inside (or equal to) `root`.
 *
 * Guards against path traversal: untrusted input such as tar archive entry
 * names or user-supplied file paths can contain ".." or absolute paths that
 * escape the intended directory. Both arguments are resolved to absolute paths
 * before comparison, and the trailing separator check prevents a sibling
 * directory that merely shares the root's prefix (e.g. "/data-evil" vs "/data")
 * from being treated as inside the root.
 */
export function isPathWithin(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}
