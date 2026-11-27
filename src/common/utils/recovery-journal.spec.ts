import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

// The real calls, which a test can make fail once: the module's own exports cannot be spied on.
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeSync: jest.fn(actual.writeSync), openSync: jest.fn(actual.openSync) };
});
const real = jest.requireActual<typeof import('node:fs')>('node:fs');
const writeSync = fs.writeSync as unknown as jest.Mock;
const openSync = fs.openSync as unknown as jest.Mock;
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryJournal, resolveRecoveryJournalPath } from './recovery-journal';
import { LoggerService } from '../services/logger.service';

describe('RecoveryJournal', () => {
  let dir: string;
  let path: string;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const actions = (spy: jest.SpyInstance): unknown[] =>
    (spy.mock.calls as unknown[][]).map(call => (call.at(-1) as { action?: string } | undefined)?.action);
  const lines = (): unknown[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as unknown);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recovery-journal-'));
    path = join(dir, 'nested', 'recovery-journal.jsonl');
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    writeSync.mockReset().mockImplementation(real.writeSync);
    openSync.mockReset().mockImplementation(real.openSync);
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to the data directory, or the path RECOVERY_JOURNAL_PATH names', () => {
    const saved = process.env.RECOVERY_JOURNAL_PATH;
    delete process.env.RECOVERY_JOURNAL_PATH;
    expect(resolveRecoveryJournalPath()).toBe('./data/recovery-journal.jsonl');
    process.env.RECOVERY_JOURNAL_PATH = '/var/lib/openwa/journal.jsonl';
    expect(resolveRecoveryJournalPath()).toBe('/var/lib/openwa/journal.jsonl');
    if (saved === undefined) delete process.env.RECOVERY_JOURNAL_PATH;
    else process.env.RECOVERY_JOURNAL_PATH = saved;
  });

  it('writes no file while nothing is kept, and one only its owner reads once something is', () => {
    const journal = new RecoveryJournal(path);
    expect(existsSync(path)).toBe(false);

    expect(journal.put('change', 'a', { n: 1 })).toBe(true);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lines()).toEqual([{ l: 'change', k: 'a', v: { n: 1 } }]);
    expect(journal.has('change', 'a')).toBe(true);
    journal.close();
  });

  it('narrows a file that is there already to its owner', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(path, '', { mode: 0o644 });
    const journal = new RecoveryJournal(path);

    journal.put('change', 'a', { n: 1 });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    journal.close();
  });

  it('restores the last line of each key, in the order the keys were first kept, each lane once', () => {
    const first = new RecoveryJournal(path);
    first.put('change', 'a', { n: 1 });
    first.put('dispatch', 'x', { n: 1 });
    first.put('change', 'b', { n: 1 });
    first.put('change', 'a', { n: 2 });
    first.put('change', 'c', { n: 1 });
    first.del('change', 'c');
    first.del('change', 'b');
    first.put('change', 'b', { n: 3 });
    first.close();

    const next = new RecoveryJournal(path);

    expect(next.waiting()).toEqual(['change', 'dispatch']);
    expect(next.take('change')).toEqual([
      ['a', { n: 2 }],
      ['b', { n: 3 }],
    ]);
    expect(next.take('change')).toEqual([]);
    expect(next.waiting()).toEqual(['dispatch']);
    expect(next.has('change', 'a')).toBe(true);
    expect(actions(warn)).toContain('recovery_journal_restored');
    // Written again with only what is kept.
    expect(lines()).toEqual([
      { l: 'change', k: 'a', v: { n: 2 } },
      { l: 'dispatch', k: 'x', v: { n: 1 } },
      { l: 'change', k: 'b', v: { n: 3 } },
    ]);
    next.close();
  });

  it('skips a torn last line with a log, and the next line written stands on its own', () => {
    const first = new RecoveryJournal(path);
    first.put('change', 'a', { n: 1 });
    first.close();
    fs.appendFileSync(path, '{"l":"change","k":"b","v":{"n');

    const next = new RecoveryJournal(path);
    next.put('change', 'c', { n: 1 });
    next.close();

    expect(actions(warn)).toContain('recovery_journal_line_skipped');
    expect(new RecoveryJournal(path).take('change')).toEqual([
      ['a', { n: 1 }],
      ['c', { n: 1 }],
    ]);
  });

  it('skips a line that is not one of its own', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(path, '{"l":"elsewhere","k":"a","v":1}\n[1]\n{"l":"change","k":"b","v":1}\n');

    const journal = new RecoveryJournal(path);

    expect(journal.take('change')).toEqual([['b', 1]]);
    expect(journal.waiting()).toEqual([]);
    journal.close();
  });

  it('empties the file once nothing is kept', () => {
    const journal = new RecoveryJournal(path);
    journal.put('change', 'a', { n: 1 });
    journal.put('copy', 'b', { n: 1 });
    journal.del('change', 'a');
    expect(lines()).toHaveLength(3);

    journal.del('copy', 'b');
    journal.del('copy', 'never kept');

    expect(readFileSync(path, 'utf8')).toBe('');
    journal.close();
  });

  it('writes the file again with only what is kept once it grew well past that', () => {
    const journal = new RecoveryJournal(path);
    let held: Record<string, unknown> = {};
    journal.snapshot('change', () => [['a', held]]);
    for (let i = 0; i < 400; i++) {
      held = { n: i, pad: 'x'.repeat(4096) };
      journal.put('change', 'a', held);
    }

    expect(statSync(path).size).toBeLessThan(2 * 1024 * 1024);
    journal.close();
    expect(new RecoveryJournal(path).take('change')).toEqual([['a', held]]);
  });

  it('empties the file when a write fails, so it never holds an older state, then writes again', () => {
    const journal = new RecoveryJournal(path);
    journal.put('change', 'a', { n: 1 });
    writeSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });

    expect(journal.put('change', 'a', { n: 2 })).toBe(false);

    expect(journal.has('change', 'a')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(actions(error)).toEqual(['recovery_journal_write_failed']);
    expect(journal.put('change', 'b', { n: 1 })).toBe(true);
    expect(lines()).toEqual([{ l: 'change', k: 'b', v: { n: 1 } }]);
    journal.close();
  });

  it('logs the failures of a disk that keeps refusing at most once a minute, with their count', () => {
    const journal = new RecoveryJournal(path);
    writeSync.mockImplementation(() => {
      throw new Error('no space left on device');
    });

    for (let i = 0; i < 5; i++) journal.put('change', `k${i}`, { n: i });

    expect(actions(error)).toEqual(['recovery_journal_write_failed']);
    journal.close();
  });

  it('adds nothing to a file it could not empty after a failed write, until it can', () => {
    const journal = new RecoveryJournal(path);
    journal.put('change', 'a', { n: 1 });
    writeSync.mockImplementationOnce(() => {
      throw new Error('I/O error');
    });
    openSync.mockImplementationOnce(() => {
      throw new Error('read-only file system');
    });

    expect(journal.put('change', 'a', { n: 2 })).toBe(false);
    openSync.mockImplementationOnce(() => {
      throw new Error('read-only file system');
    });
    expect(journal.put('change', 'b', { n: 1 })).toBe(false);

    expect(journal.put('change', 'c', { n: 1 })).toBe(true);
    expect(lines()).toEqual([{ l: 'change', k: 'c', v: { n: 1 } }]);
    journal.close();
  });

  it('starts empty, with a log, when the file is there but cannot be read', () => {
    mkdirSync(path, { recursive: true });

    const journal = new RecoveryJournal(path);

    expect(journal.waiting()).toEqual([]);
    expect(actions(error)).toEqual(['recovery_journal_write_failed']);
    expect(journal.put('change', 'a', { n: 1 })).toBe(false);
    journal.close();
  });

  it('logs the records it keeps at shutdown and those nothing takes', () => {
    const journal = new RecoveryJournal(path);
    journal.noteKept(0);
    journal.noteKept(2);
    journal.noteUnclaimed('send', 1);

    expect(actions(warn)).toEqual(['recovery_journal_kept']);
    expect(actions(error)).toEqual(['recovery_journal_unclaimed']);
    journal.close();
    journal.close();
  });
});
