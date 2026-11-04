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
  if (root && !isPathWithin(localPath, root)) return;
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

export function getLocalFile(localPath: string, filePath: string): Promise<Buffer> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to read outside storage root: ${filePath}`);
  }
  const fullPath = path.join(localPath, filePath);
  // Async read so a media read yields the event loop instead of blocking it for the whole file.
  return fs.promises.readFile(fullPath);
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
  const handle = await fs.promises.open(path.join(localPath, filePath), 'r');
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
  const fullPath = path.join(localPath, filePath);

  // Async, non-blocking: a synchronous write here stalls the event loop during an import.
  // mkdir recursive is idempotent, so it doubles as the existsSync check.
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, data);
}

export async function deleteLocalFile(localPath: string, filePath: string): Promise<void> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to delete outside storage root: ${filePath}`);
  }
  const fullPath = path.join(localPath, filePath);
  try {
    await fs.promises.unlink(fullPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
