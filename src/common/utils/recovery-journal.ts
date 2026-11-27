import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, chmodSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { createLogger } from '../services/logger.service';

/** What the journal keeps: the recovery queue's lanes, and the copies of queued deliveries with no outbox row. */
export type JournalLane = 'send' | 'receive' | 'history' | 'change' | 'dispatch' | 'copy';
const JOURNAL_LANES: readonly JournalLane[] = ['send', 'receive', 'history', 'change', 'dispatch', 'copy'];

interface JournalLine {
  l: JournalLane;
  k: string;
  /** What is kept under the key; absent on the line that says it left. */
  v?: unknown;
}

const isJournalLine = (line: unknown): line is JournalLine => {
  const l = line as Partial<JournalLine> | null;
  return typeof l === 'object' && l !== null && JOURNAL_LANES.includes(l.l as JournalLane) && typeof l.k === 'string';
};

/** The journal's file: RECOVERY_JOURNAL_PATH, else beside the other data under ./data. */
export function resolveRecoveryJournalPath(): string {
  return process.env.RECOVERY_JOURNAL_PATH || './data/recovery-journal.jsonl';
}

/** Past this much more than what is kept, the file is written again with only what is kept. */
const COMPACT_SLACK = 1024 * 1024;
const WARN_EVERY_MS = 60_000;

/**
 * What the database refused and this process keeps (the recovery queue's records, the copies of queued deliveries
 * whose outbox rows were never written), on disk so a restart or a crash finds it again: a JSON line per record kept or
 * changed and one per record that left, each fsynced; the last line of a key wins. A file is written only while
 * something is kept, emptied once nothing is, and written again with only what is kept when it loads and when it has
 * grown well past that. A line that cannot be read (a torn last line) is skipped with a log. A write that fails is
 * logged and empties the file: what is kept stays in memory only, and the file never holds an older state than memory.
 * One process owns the file.
 */
export class RecoveryJournal {
  private readonly logger = createLogger('RecoveryJournal');
  private fd?: number;
  // The length of the line of each record kept now (by lane and key), their sum, and what the file holds.
  private readonly live = new Map<string, number>();
  // A digest of the line last written for each of them, so a record kept again unchanged (a retry that could not run
  // yet) writes and fsyncs nothing.
  private readonly digests = new Map<string, string>();
  private liveBytes = 0;
  private fileBytes = 0;
  // What the last process left, by lane, until the lane's owner takes it.
  private readonly restored = new Map<JournalLane, Array<[string, unknown]>>();
  private readonly snapshots = new Map<JournalLane, () => Iterable<[string, unknown]>>();
  // Set when the file could not be emptied after a failed write: it may hold an older state, so nothing is added to it.
  private stale = false;
  private readonly warning = { at: -Infinity, held: 0 };

  constructor(readonly path: string = resolveRecoveryJournalPath()) {
    this.load();
  }

  /** The lanes the last process left records in that no owner took yet. */
  waiting(): JournalLane[] {
    return [...this.restored.keys()];
  }

  /** What the last process left in a lane, in the order it was kept; each is handed out once. */
  take(lane: JournalLane): Array<[string, unknown]> {
    const entries = this.restored.get(lane) ?? [];
    this.restored.delete(lane);
    return entries;
  }

  /** How a lane's owner lists what it keeps now, for the file to be written again with only that. */
  snapshot(lane: JournalLane, entries: () => Iterable<[string, unknown]>): void {
    this.snapshots.set(lane, entries);
  }

  /** Whether the file holds a record now. */
  has(lane: JournalLane, key: string): boolean {
    return this.live.has(`${lane}\u0000${key}`);
  }

  /** Keep a record, or what it holds now; false when it could not be written, and it stays in memory only. */
  put(lane: JournalLane, key: string, value: unknown): boolean {
    if (this.stale && !this.empty()) return false;
    const line = `${JSON.stringify({ l: lane, k: key, v: value })}\n`;
    const id = `${lane}\u0000${key}`;
    const digest = createHash('sha256').update(line).digest('base64');
    if (this.live.has(id) && this.digests.get(id) === digest) return true;
    if (!this.write(line)) return false;
    this.liveBytes += line.length - (this.live.get(id) ?? 0);
    this.live.set(id, line.length);
    this.digests.set(id, digest);
    if (this.fileBytes > 2 * this.liveBytes + COMPACT_SLACK) this.compact();
    return true;
  }

  /** A record left: settled, given up on or forgotten. The file is emptied once nothing is kept. */
  del(lane: JournalLane, key: string): void {
    const id = `${lane}\u0000${key}`;
    const size = this.live.get(id);
    if (size === undefined) return;
    this.live.delete(id);
    this.digests.delete(id);
    this.liveBytes -= size;
    if (this.live.size === 0) this.empty();
    else this.write(`${JSON.stringify({ l: lane, k: key })}\n`);
  }

  /** Records kept at shutdown that stay in the file for the next start. */
  noteKept(count: number): void {
    if (count > 0) {
      this.logger.warn('Keeping what the database refused in the recovery journal for the next start', {
        path: this.path,
        records: count,
        action: 'recovery_journal_kept',
      });
    }
  }

  /** Records the last process left that nothing took (a lane with no owner now): they are let go. */
  noteUnclaimed(lane: JournalLane, count: number): void {
    this.logger.error('Records in the recovery journal that nothing can take are lost', undefined, {
      path: this.path,
      lane,
      records: count,
      action: 'recovery_journal_unclaimed',
    });
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // Closing a descriptor that is gone has nothing left to undo.
    }
    this.fd = undefined;
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.warn('Could not read the recovery journal: what the last process kept is lost', error);
      this.stale = true;
      return;
    }
    const entries = new Map<string, JournalLine>();
    let skipped = 0;
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        skipped++;
        continue;
      }
      if (!isJournalLine(line)) {
        skipped++;
        continue;
      }
      const id = `${line.l}\u0000${line.k}`;
      // A key kept again keeps its place, as in the queue; one that left and came back goes last.
      if (line.v === undefined) entries.delete(id);
      else entries.set(id, line);
    }
    if (skipped) {
      this.logger.warn('Skipped lines of the recovery journal that could not be read', {
        path: this.path,
        skipped,
        action: 'recovery_journal_line_skipped',
      });
    }
    for (const line of entries.values()) {
      const lane = this.restored.get(line.l) ?? [];
      this.restored.set(line.l, lane);
      lane.push([line.k, line.v]);
    }
    // Only what is kept, so a torn last line cannot run into the first line written after it.
    this.rewrite([...entries.values()]);
    if (entries.size) {
      this.logger.warn('Restoring what the database refused before the last stop, from the recovery journal', {
        path: this.path,
        records: entries.size,
        action: 'recovery_journal_restored',
      });
    }
  }

  /** Write the file again with what every lane keeps now, and what the last process left that no owner took yet. */
  private compact(): void {
    const lines: JournalLine[] = [];
    for (const l of JOURNAL_LANES) {
      for (const [k, v] of this.restored.get(l) ?? []) lines.push({ l, k, v });
      for (const [k, v] of this.snapshots.get(l)?.() ?? []) if (this.has(l, k)) lines.push({ l, k, v });
    }
    this.rewrite(lines);
  }

  private rewrite(lines: JournalLine[]): void {
    const text = lines.map(line => `${JSON.stringify(line)}\n`).join('');
    const temp = `${this.path}.tmp`;
    try {
      this.close();
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(temp, 'w', 0o600);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      this.syncDirectory();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.live.clear();
    this.digests.clear();
    this.liveBytes = 0;
    for (const line of lines) {
      const size = JSON.stringify(line).length + 1;
      this.live.set(`${line.l}\u0000${line.k}`, size);
      this.liveBytes += size;
    }
    this.fileBytes = text.length;
    this.stale = false;
  }

  private syncDirectory(): void {
    try {
      const dir = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      // Not every platform opens a directory for fsync; the rename is still in place.
    }
  }

  private write(line: string): boolean {
    try {
      if (this.fd === undefined) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.fd = openSync(this.path, 'a', 0o600);
        chmodSync(this.path, 0o600);
      }
      writeSync(this.fd, line);
      fsyncSync(this.fd);
      this.fileBytes += line.length;
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** A write failed: the file is emptied, so it never holds an older state than memory, and what is kept stays there. */
  private fail(error: unknown): void {
    this.warn('Could not write the recovery journal: what is kept now is in memory only', error);
    this.live.clear();
    this.digests.clear();
    this.liveBytes = 0;
    this.stale = !this.empty();
  }

  /** Empty the file; true once it holds nothing. */
  private empty(): boolean {
    this.close();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      closeSync(openSync(this.path, 'w', 0o600));
    } catch (error) {
      this.warn('Could not empty the recovery journal', error);
      return false;
    }
    this.fileBytes = 0;
    this.stale = false;
    return true;
  }

  private warn(message: string, error: unknown): void {
    const now = Date.now();
    this.warning.held++;
    if (now - this.warning.at < WARN_EVERY_MS) return;
    this.logger.error(message, undefined, {
      path: this.path,
      error: error instanceof Error ? error.message : String(error),
      failures: this.warning.held,
      action: 'recovery_journal_write_failed',
    });
    this.warning.at = now;
    this.warning.held = 0;
  }
}
