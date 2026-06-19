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

/**
 * Returns true if `key` is a safe, contained relative storage key: a non-empty relative path with no
 * `..` traversal segment. Used to validate untrusted archive entry names / object keys at the
 * backend-agnostic `putFile`/`getFile` boundary so an S3 key (which has no host filesystem root to
 * check against `isPathWithin`) still can't escape the intended `media/` prefix. Ordinary keys —
 * including plugin/JID-style ones with `:`, `@`, `.`, `-` — are preserved.
 */
export function isSafeStorageKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  // Reject NUL / control chars: harmless on the local FS but a NUL would reach the raw S3 object Key.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(key)) return false;
  if (path.isAbsolute(key)) return false;
  return !key.split(/[/\\]/).includes('..');
}
