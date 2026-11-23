import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import type { LoggerService } from '../services/logger.service';
import { isPathWithin } from '../utils/path-safety';

/** Max directory depth a local traversal descends. Prevents a pathological tree from running unbounded. */
const LOCAL_TRAVERSAL_MAX_DEPTH = 20;

/**
 * The walk refuses to go on because it cannot enumerate part of the store completely: a directory the app cannot
 * read, a symbolic link it does not follow, a directory nested past the depth limit. A count or an export that went
 * on would leave files out without a word. The message reaches the API caller, so it names the path relative to
 * the storage root and the cause, never the host path; the error the host raised, with its path, is on `cause`.
 */
export class StorageWalkRefusedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageWalkRefusedError';
  }
}

export interface LocalWalkOptions {
  /**
   * Skip a path the walk cannot enumerate, naming it in a warning, instead of failing the walk. Only for a
   * caller that acts on the files it saw and nothing else, such as an orphan sweep: it leaves the subtree it
   * could not read alone. An export or a count must not set it, because a short answer hides files.
   */
  skipUnreadable?: boolean;
  logger?: Pick<LoggerService, 'log' | 'warn'>;
}

/** Created by mkfs at the top of a volume; root-owned and mode 0700, so an unprivileged app cannot read it. */
const LOST_AND_FOUND = 'lost+found';

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT';
}

const MAX_SYMLINK_DEPTH = 40;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NOFOLLOW_WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW;

/**
 * Resolve a symlink target left-to-right the way POSIX does, following every existing
 * intermediate component (and any dangling intermediate symlink) before applying `..`.
 * Unlike `path.resolve`, this never lexically collapses `symlink/..` before dereferencing
 * `symlink`, so a dangling link like `escape-dir/../missing.bin` resolves outside `realRoot`.
 */
async function resolvePathLeftToRight(startDir: string, target: string, depth = 0): Promise<string> {
  if (depth > MAX_SYMLINK_DEPTH) {
    const err = new Error('Too many levels of symbolic links') as NodeJS.ErrnoException;
    err.code = 'ELOOP';
    throw err;
  }
  const parsed = path.parse(target);
  const isAbs = path.isAbsolute(target);
  let current = isAbs ? parsed.root : startDir;
  const remainder = isAbs ? target.slice(parsed.root.length) : target;
  const segments = remainder.split(/[/\\]+/).filter(Boolean);
  let missing = false;

  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      try {
        current = await fs.promises.realpath(current);
        missing = false;
      } catch (error) {
        if (!isEnoent(error)) throw error;
        missing = true;
      }
      continue;
    }

    const next = path.join(current, segment);
    if (missing) {
      current = next;
      continue;
    }

    let realNext: string | null = null;
    try {
      realNext = await fs.promises.realpath(next);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (realNext !== null) {
      current = realNext;
      continue;
    }

    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.lstat(next);
    } catch (lstatError) {
      if (!isEnoent(lstatError)) throw lstatError;
    }
    if (stat?.isSymbolicLink()) {
      const nestedTarget = await fs.promises.readlink(next);
      current = await resolvePathLeftToRight(current, nestedTarget, depth + 1);
      try {
        current = await fs.promises.realpath(current);
        missing = false;
      } catch (error) {
        if (!isEnoent(error)) throw error;
        missing = true;
      }
      continue;
    }

    current = next;
    missing = true;
  }

  return current;
}

/**
 * Walk upward from `startPath` to the deepest existing ancestor inside `localPath`, verifying
 * that its canonical path stays within `realRoot`. Rejects any dangling symbolic link along
 * the walk because its target cannot be resolved and verified inside the storage root.
 */
async function assertAncestorsWithinRoot(
  localPath: string,
  realRoot: string,
  startPath: string,
  action: 'write' | 'delete',
  filePath: string,
): Promise<string> {
  const resolvedRoot = path.resolve(localPath);
  let current = path.resolve(startPath);
  for (;;) {
    let realCurrent: string | null = null;
    try {
      realCurrent = await fs.promises.realpath(current);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (realCurrent !== null) {
      if (!isPathWithin(realRoot, realCurrent)) {
        throw new Error(`Refusing to ${action} outside storage root: ${filePath}`);
      }
      return realCurrent;
    }
    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.lstat(current);
    } catch (lstatError) {
      if (!isEnoent(lstatError)) throw lstatError;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing to ${action} through symbolic link: ${filePath}`);
    }
    if (current === resolvedRoot) return realRoot;
    const parent = path.dirname(current);
    if (parent === current) return realRoot;
    current = parent;
  }
}

/**
 * Local enumeration as a stream. Async + iterative (a work queue, not recursion) so a deep/wide
 * media tree can't block the event loop or stack-overflow; still bounded by the max directory
 * depth. An incomplete traversal fails instead of hiding files, unless the caller opts out.
 */
export async function* iterateLocalFiles(
  localPath: string,
  prefix = '',
  options: LocalWalkOptions = {},
): AsyncGenerator<string> {
  /** A path the walk cannot enumerate: fail the walk, or skip it and say so when the caller allows it. */
  const unreadable = (entry: string, error: Error): void => {
    if (!options.skipUnreadable) throw error;
    // The log gets the host's own account of the failure, with its path.
    const detail = error instanceof StorageWalkRefusedError && error.cause instanceof Error ? error.cause : error;
    options.logger?.warn(
      `Skipping a storage path that cannot be enumerated: ${JSON.stringify(entry)} (${detail.message})`,
    );
  };
  // Iterative BFS: a queue of [relativeDir, depth] avoids unbounded call-stack growth. A prefix
  // ending in '/' names a subtree, so start the walk there instead of filtering afterwards.
  const root = prefix.endsWith('/') ? prefix.slice(0, -1) : '';
  if (root) {
    if (!isPathWithin(localPath, root)) return;
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await fs.promises.realpath(localPath);
      realTarget = await fs.promises.realpath(path.join(localPath, root));
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    if (!isPathWithin(realRoot, realTarget)) {
      throw new Error(`Refusing to read outside storage root: ${root}`);
    }
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth >= LOCAL_TRAVERSAL_MAX_DEPTH) {
      unreadable(dir, new StorageWalkRefusedError(`Storage directory exceeds the maximum traversal depth: ${dir}`));
      continue;
    }

    const fullPath = path.join(localPath, dir);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A directory removed during enumeration has no files left to export.
      if (code === 'ENOENT') continue;
      const permission = code === 'EACCES' || code === 'EPERM';
      if (dir === LOST_AND_FOUND && permission) {
        options.logger?.log(`Skipping the unreadable ${LOST_AND_FOUND} directory at the storage root`);
        continue;
      }
      // Only a permission failure is one the operator can fix, so only it is refused with a cause the caller can
      // read. Any other failure (an I/O error, say) goes on as it came, and is an internal error.
      unreadable(
        dir,
        permission
          ? new StorageWalkRefusedError(`Storage directory cannot be read: ${dir || '.'} (${code})`, { cause: error })
          : (error as Error),
      );
      continue;
    }

    for (const entry of entries) {
      // Keys use "/" on every host: the archive carries them verbatim, and a key with a backslash would
      // restore as a different file on another host.
      const relativePath = dir ? path.posix.join(dir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        queue.push({ dir: relativePath, depth: depth + 1 });
      } else if (entry.isFile()) {
        yield relativePath;
      } else if (entry.isSymbolicLink()) {
        // Not followed: a link can loop or leave the store, and what it points at would be missing from the
        // listing. getFile and a walk that starts below the link still reach it.
        unreadable(
          relativePath,
          new StorageWalkRefusedError(`Storage path is a symbolic link and is not followed: ${relativePath}`),
        );
      }
    }
  }
}

export async function getLocalFile(localPath: string, filePath: string): Promise<Buffer> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to read outside storage root: ${filePath}`);
  }
  const fullPath = path.join(localPath, filePath);
  const realRoot = await fs.promises.realpath(localPath);
  const realTarget = await fs.promises.realpath(fullPath);
  if (!isPathWithin(realRoot, realTarget)) {
    throw new Error(`Refusing to read outside storage root: ${filePath}`);
  }
  // Async read so a media read yields the event loop instead of blocking it for the whole file.
  return fs.promises.readFile(realTarget);
}

/**
 * Open a local file for a streamed read. The handle is opened and stat'ed up front, so a missing or
 * unreadable file rejects here, before the caller commits to it, and the size is the one the open
 * handle sees. The stream closes the handle when it ends or is destroyed.
 */
export async function openLocalFile(localPath: string, filePath: string): Promise<{ stream: Readable; size: number }> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to read outside storage root: ${filePath}`);
  }
  const fullPath = path.join(localPath, filePath);
  const realRoot = await fs.promises.realpath(localPath);
  const realTarget = await fs.promises.realpath(fullPath);
  if (!isPathWithin(realRoot, realTarget)) {
    throw new Error(`Refusing to read outside storage root: ${filePath}`);
  }
  const handle = await fs.promises.open(realTarget, 'r');
  try {
    const { size } = await handle.stat();
    return { stream: handle.createReadStream(), size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function putLocalFile(localPath: string, filePath: string, data: Buffer): Promise<void> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to write outside storage root: ${filePath}`);
  }
  const resolvedRoot = path.resolve(localPath);
  const fullPath = path.resolve(resolvedRoot, filePath);
  if (fullPath === resolvedRoot) {
    throw new Error(`Refusing to write outside storage root: ${filePath}`);
  }

  const parentDir = path.dirname(fullPath);
  let realRoot: string;
  let realParent: string | null;
  if (parentDir === resolvedRoot) {
    try {
      realRoot = await fs.promises.realpath(resolvedRoot);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      await fs.promises.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
      realRoot = await fs.promises.realpath(resolvedRoot);
    }
    realParent = realRoot;
  } else {
    const [rootRes, parentRes] = await Promise.all([
      fs.promises.realpath(resolvedRoot).catch((error: unknown) => {
        if (isEnoent(error)) return null;
        throw error;
      }),
      fs.promises.realpath(parentDir).catch((error: unknown) => {
        if (isEnoent(error)) return null;
        throw error;
      }),
    ]);
    if (rootRes === null) {
      await fs.promises.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
      realRoot = await fs.promises.realpath(resolvedRoot);
    } else {
      realRoot = rootRes;
    }
    realParent = parentRes;
  }

  if (realParent === null) {
    await assertAncestorsWithinRoot(localPath, realRoot, parentDir, 'write', filePath);
    // Async, non-blocking: a synchronous write here stalls the event loop during an import.
    // mkdir recursive is idempotent, so it doubles as the existsSync check. What it creates is owner-only (0700
    // directories, 0600 files), as the databases and the engine auth directories are.
    await fs.promises.mkdir(parentDir, { recursive: true, mode: 0o700 });
    realParent = await fs.promises.realpath(parentDir);
  }
  if (!isPathWithin(realRoot, realParent)) {
    throw new Error(`Refusing to write outside storage root: ${filePath}`);
  }

  const targetPath = path.join(realParent, path.basename(fullPath));
  if (O_NOFOLLOW !== 0) {
    try {
      await fs.promises.writeFile(targetPath, data, { mode: 0o600, flag: NOFOLLOW_WRITE_FLAGS });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      if (code === 'ELOOP' || code === 'EMLINK') {
        throw new Error(`Refusing to write through symbolic link: ${filePath}`, { cause: error });
      }
      throw error;
    }
  }

  let targetStat: fs.Stats | null = null;
  try {
    targetStat = await fs.promises.lstat(targetPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Refusing to write through symbolic link: ${filePath}`);
  }
  await fs.promises.writeFile(targetPath, data, { mode: 0o600 });
}

export async function deleteLocalFile(localPath: string, filePath: string): Promise<void> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to delete outside storage root: ${filePath}`);
  }
  const resolvedRoot = path.resolve(localPath);
  const fullPath = path.resolve(resolvedRoot, filePath);
  if (fullPath === resolvedRoot) {
    throw new Error(`Refusing to delete outside storage root: ${filePath}`);
  }

  const parentDir = path.dirname(fullPath);
  let realRoot: string;
  let realParent: string;
  if (parentDir === resolvedRoot) {
    try {
      realRoot = await fs.promises.realpath(resolvedRoot);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    realParent = realRoot;
  } else {
    const [rootRes, parentRes] = await Promise.all([
      fs.promises.realpath(resolvedRoot).catch((error: unknown) => {
        if (isEnoent(error)) return null;
        throw error;
      }),
      fs.promises.realpath(parentDir).catch((error: unknown) => {
        if (isEnoent(error)) return null;
        throw error;
      }),
    ]);
    if (rootRes === null) return;
    if (parentRes === null) {
      await assertAncestorsWithinRoot(localPath, rootRes, parentDir, 'delete', filePath);
      return;
    }
    realRoot = rootRes;
    realParent = parentRes;
  }

  if (!isPathWithin(realRoot, realParent)) {
    throw new Error(`Refusing to delete outside storage root: ${filePath}`);
  }
  const targetPath = path.join(realParent, path.basename(fullPath));

  let targetStat: fs.Stats;
  try {
    targetStat = await fs.promises.lstat(targetPath);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

  if (targetStat.isSymbolicLink()) {
    let realTarget: string | null = null;
    try {
      realTarget = await fs.promises.realpath(targetPath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (realTarget !== null) {
      if (!isPathWithin(realRoot, realTarget)) {
        throw new Error(`Refusing to delete outside storage root: ${filePath}`);
      }
    } else {
      const linkTarget = await fs.promises.readlink(targetPath);
      const resolvedTarget = await resolvePathLeftToRight(realParent, linkTarget);
      if (!isPathWithin(realRoot, resolvedTarget)) {
        throw new Error(`Refusing to delete outside storage root: ${filePath}`);
      }
    }
    if (/[/\\]$/.test(filePath)) {
      throw new Error(`Refusing to delete through symbolic link: ${filePath}`);
    }
  }

  try {
    await fs.promises.unlink(targetPath);
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }
}
