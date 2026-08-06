import * as fs from 'fs';
import * as path from 'path';
import { isPathWithin } from '../utils/path-safety';

/** Max number of local files a single traversal enumerates. Bounds a count DoS on a huge media dir. */
const DEFAULT_LIST_MAX_FILES = 100_000;
/** Max directory depth a local traversal descends. Prevents a pathological tree from running unbounded. */
const LOCAL_TRAVERSAL_MAX_DEPTH = 20;

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Enumerate local files under the storage root, capped at STORAGE_LIST_MAX_FILES — a per-call
 * DoS guard (a healthy media store stays well under it), NOT a completeness contract. Callers
 * that must see the whole tree use iterateFiles().
 */
export async function listLocalFiles(localPath: string): Promise<string[]> {
  const maxFiles = positiveIntFromEnv('STORAGE_LIST_MAX_FILES', DEFAULT_LIST_MAX_FILES);
  const files: string[] = [];
  for await (const file of iterateLocalFiles(localPath)) {
    files.push(file);
    if (files.length >= maxFiles) break; // cap reached — stop early
  }
  return files;
}

/**
 * Full local enumeration as a stream — no count cap. Async + iterative (a work queue, not
 * recursion) so a deep/wide media tree can't block the event loop or stack-overflow; still
 * bounded by the max directory depth so a pathological tree can't descend unbounded.
 */
export async function* iterateLocalFiles(localPath: string, prefix = ''): AsyncGenerator<string> {
  // Iterative BFS: a queue of [relativeDir, depth] avoids unbounded call-stack growth. A prefix
  // ending in '/' names a subtree, so start the walk there instead of filtering afterwards.
  const root = prefix.endsWith('/') ? prefix.slice(0, -1) : '';
  if (root && !isPathWithin(localPath, root)) return;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth >= LOCAL_TRAVERSAL_MAX_DEPTH) continue;

    const fullPath = path.join(localPath, dir);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    } catch {
      continue; // dir vanished or unreadable — skip rather than abort the whole traversal
    }

    for (const entry of entries) {
      const relativePath = dir ? path.join(dir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        queue.push({ dir: relativePath, depth: depth + 1 });
      } else if (entry.isFile()) {
        yield relativePath;
      }
    }
  }
}

export function getLocalFile(localPath: string, filePath: string): Promise<Buffer> {
  if (!isPathWithin(localPath, filePath)) {
    throw new Error(`Refusing to read outside storage root: ${filePath}`);
  }
  const fullPath = path.join(localPath, filePath);
  // Async read so the export loop (the only caller) yields the event loop per file instead of
  // blocking it with a synchronous read for every media file.
  return fs.promises.readFile(fullPath);
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
