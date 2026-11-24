import * as fs from 'fs';
import * as path from 'path';

function isContainedPath(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

export function lstatIfPresent(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Walk every path segment from `baseDir` down to `targetPath` verifying via lstatSync/realpathSync
 * that no existing or dangling symbolic link can escape `baseDir`. If `baseDir` does not yet exist
 * on disk (such as non-filesystem unit checks), only lexical containment applies.
 */
export function assertPathContainedNoSymlinkEscape(
  baseDir: string,
  targetPath: string,
  errorFactory: (detail: string) => Error,
): void {
  const absBase = path.resolve(baseDir);
  const absTarget = path.resolve(targetPath);
  if (!isContainedPath(absBase, absTarget)) {
    throw errorFactory('escapes the plugin directory');
  }
  const baseStat = lstatIfPresent(absBase);
  if (!baseStat) return;
  if (baseStat.isSymbolicLink()) {
    throw errorFactory('resolves through a symbolic link');
  }
  const realBase = fs.realpathSync(absBase);
  const rel = path.relative(absBase, absTarget);
  if (!rel) return;

  let current = absBase;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = fs.realpathSync(current);
      } catch {
        throw errorFactory('escapes the plugin directory via symbolic link');
      }
      if (!isContainedPath(realBase, resolved)) {
        throw errorFactory('escapes the plugin directory via symbolic link');
      }
    }
  }
}

/**
 * Verify that writing or removing `relPath` inside an existing `baseDir` neither leaves `baseDir`
 * nor traverses/targets any symbolic link (including dangling symlinks).
 */
export function assertWritePathNoSymlinks(
  baseDir: string,
  relPath: string,
  errorFactory: (detail: string) => Error,
): void {
  const absBase = path.resolve(baseDir);
  const absTarget = path.resolve(absBase, relPath);
  if (!isContainedPath(absBase, absTarget)) {
    throw errorFactory('escapes the plugin directory');
  }
  const baseStat = lstatIfPresent(absBase);
  if (!baseStat) return;
  if (baseStat.isSymbolicLink()) {
    throw errorFactory('resolves through a symbolic link');
  }
  const rel = path.relative(absBase, absTarget);
  if (!rel) return;

  let current = absBase;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw errorFactory('traverses or targets a symbolic link');
    }
  }
}

/**
 * Resolve a plugin's `main` entry to an absolute path, asserting it stays inside
 * <pluginsDir>/<pluginId>. `main` comes from a user-supplied manifest, so a
 * value like '../../etc/passwd' (or an absolute path) or a symlink escape must be
 * rejected BEFORE require().
 */
export function resolvePluginMainPath(pluginsDir: string, pluginId: string, main: string): string {
  const base = path.resolve(pluginsDir, pluginId);
  const mainPath = path.resolve(base, main);
  assertPathContainedNoSymlinkEscape(base, mainPath, detail => new Error(`Plugin ${pluginId} main path ${detail}`));
  return mainPath;
}

/**
 * The same containment guard, anchored to a plugin's own package directory rather than to the
 * configured plugins root. Callers that hold a loaded plugin's `packageDir` use this: the package
 * may sit in the legacy directory, in which case resolving against `plugins.dir` names a file that
 * does not exist.
 */
export function resolvePluginEntryPath(packageDir: string, entry: string): string {
  return resolvePluginMainPath(path.dirname(packageDir), path.basename(packageDir), entry);
}

/**
 * Sibling directory names an in-place plugin update stages into / backs up to (see
 * PluginsService.updatePackageInner). Dot-prefixed so the boot directory scan skips them, and placed
 * inside the plugins dir so the swap renames stay on one filesystem (EXDEV-safe). The scanner's
 * boot-time reconciler (recoverInterruptedUpdates) keys off these exact names.
 */
export function pluginUpdateStagingDirName(pluginId: string): string {
  return `.${pluginId}.new`;
}
export function pluginUpdateBackupDirName(pluginId: string): string {
  return `.${pluginId}.bak`;
}
