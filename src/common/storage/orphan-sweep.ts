import { StorageService } from './storage.service';

/**
 * One reconciliation pass over a storage prefix: delete files no row references, but only after the
 * sweep has seen them unreferenced for at least the grace window. Shared by the stores that keep
 * media blobs alongside DB rows (status store, chat-media archive) and share one bucket — each
 * caller scopes itself to its own prefix and never touches the other's files.
 *
 * First-seen is tracked in the caller-owned `firstSeenAt` map (epoch ms per unreferenced key), so a
 * restart simply restarts the grace clock (fails safe) and a file mid-write is never reaped. The map
 * is pruned to the keys still orphaned at the end of the pass, so it cannot grow unbounded.
 *
 * Files are streamed from iterateFiles() under the sweep's prefix, so an orphan is found however
 * large the store is.
 *
 * Returns the number of files deleted. The summary log stays with the caller (each sweep reports in
 * its own wording); a failed delete is reported through `onDeleteFailed` and retried on a later pass.
 */
export async function sweepOrphanedFiles(options: {
  storage: Pick<StorageService, 'iterateFiles' | 'deleteFile'>;
  /** Storage key prefix this sweep owns; files not under it are never touched. */
  prefix: string;
  /** Grace window (ms) before an unreferenced file is deleted. */
  graceMs: number;
  /** Timestamp the pass runs at (epoch ms). */
  now: number;
  /** Caller-owned first-sighting map (epoch ms per unreferenced key); mutated in place. */
  firstSeenAt: Map<string, number>;
  /**
   * Resolve which of the given keys are still referenced by a row. May return a superset (e.g. one
   * whole-set query when the referenced set is small and bounded) — only membership is read.
   */
  referencedAmong: (keys: string[]) => Promise<ReadonlySet<string | undefined>>;
  /**
   * Bound on the keys per referencedAmong call. Set it when the referenced set can grow without
   * bound: reconciling in chunks keeps each lookup an indexed query over a bounded key list instead
   * of materialising every key and every referenced row at once. Unset = one call with the whole
   * enumeration.
   */
  chunkSize?: number;
  /** Caller-worded warning for a delete that failed; the file stays for the next pass. */
  onDeleteFailed: (key: string, error: unknown) => void;
}): Promise<number> {
  const { storage, prefix, graceMs, now, firstSeenAt, referencedAmong, onDeleteFailed } = options;
  let removed = 0;
  // Keys still unreferenced at the end of THIS pass; drives the bookkeeping prune below. Bounded by
  // the orphan count (normally ~0), not by the size of the store.
  const stillOrphaned = new Set<string>();

  let chunk: string[] = [];
  const flush = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const referenced = await referencedAmong(chunk);
    for (const file of chunk) {
      if (referenced.has(file)) {
        firstSeenAt.delete(file);
        continue;
      }
      stillOrphaned.add(file);
      const firstSeen = firstSeenAt.get(file) ?? now;
      firstSeenAt.set(file, firstSeen);
      if (now - firstSeen < graceMs) continue;
      try {
        await storage.deleteFile(file);
        firstSeenAt.delete(file);
        stillOrphaned.delete(file);
        removed += 1;
      } catch (err) {
        onDeleteFailed(file, err);
      }
    }
    chunk = [];
  };

  // A directory the walk cannot read is left alone: this pass deletes only files it was shown.
  for await (const file of storage.iterateFiles(prefix, { skipUnreadable: true })) {
    if (!file.startsWith(prefix)) continue;
    chunk.push(file);
    if (options.chunkSize !== undefined && chunk.length >= options.chunkSize) await flush();
  }
  await flush();

  // Drop bookkeeping for anything not still orphaned this pass — the file is gone, or a row now
  // references it. Keyed off the orphan set rather than a full listing so this stays bounded too.
  for (const key of [...firstSeenAt.keys()]) {
    if (!stillOrphaned.has(key)) firstSeenAt.delete(key);
  }
  return removed;
}
