import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryJournal } from './recovery-journal';
import { LoggerService } from '../services/logger.service';
import {
  RECOVERY_MAX_RECORD_FAILURES,
  RecoveryQueue,
  isDatabaseUnavailable,
  type RecoveryCodec,
  type RecoveryLane,
  type RecoveryLoss,
  type RecoveryRecord,
  type RecoveryQueueOptions,
} from './recovery-queue';

const down = (): Error => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });

describe('RecoveryQueue', () => {
  let now: number;
  let log: string[];
  const options = (over: Partial<RecoveryQueueOptions> = {}): RecoveryQueueOptions => ({
    maxBytes: 1000,
    maxRecords: { send: 10, change: 3, dispatch: 10 },
    maxAgeMs: { send: 60_000, change: 60_000, dispatch: 60_000 },
    baseDelayMs: 1000,
    capDelayMs: 8000,
    now: () => now,
    ...over,
  });
  const record = (
    name: string,
    lane: RecoveryLane = 'change',
    over: Partial<{
      bytes: number;
      ageCapped: boolean;
      retry: () => Promise<boolean>;
      prepare: () => Promise<void>;
    }> = {},
  ): RecoveryRecord & { lostAs?: RecoveryLoss } => {
    const r: RecoveryRecord & { lostAs?: RecoveryLoss } = {
      lane,
      sessionId: name.startsWith('other') ? 's2' : 's1',
      since: now++,
      bytes: () => over.bytes ?? 1,
      ageCapped: () => over.ageCapped ?? true,
      retry: over.retry ?? (() => (log.push(`retry ${name}`), Promise.resolve(true))),
      ...(over.prepare ? { prepare: over.prepare } : {}),
      lost: reason => {
        r.lostAs = reason;
        log.push(`lost ${name} ${reason}`);
      },
    };
    return r;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    now = 1_000_000;
    log = [];
  });
  afterEach(() => jest.useRealTimers());

  it('runs every outbox step before any retry, lanes in order and oldest first', async () => {
    const queue = new RecoveryQueue(options());
    const prepare = (name: string) => () => (log.push(`prepare ${name}`), Promise.resolve());
    queue.park('d', record('d', 'dispatch'));
    queue.park('a', record('a', 'change', { prepare: prepare('a') }));
    queue.park('b', record('b', 'change', { prepare: prepare('b') }));
    queue.park('s', record('s', 'send'));

    await queue.flush();

    expect(log).toEqual(['prepare a', 'prepare b', 'retry s', 'retry a', 'retry b', 'retry d']);
    expect(queue.size).toBe(0);
  });

  it('starts a pass after the first delay on its own timer', async () => {
    const queue = new RecoveryQueue(options());
    queue.park('a', record('a'));

    await jest.advanceTimersByTimeAsync(999);
    expect(log).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['retry a']);
  });

  it('backs off while the database fails, probes one record a pass, and drains every record once it answers', async () => {
    const queue = new RecoveryQueue(options());
    let available = false;
    const flaky = (name: string) => () => {
      log.push(`retry ${name}`);
      return available ? Promise.resolve(true) : Promise.reject(down());
    };
    queue.park('a', record('a', 'change', { retry: flaky('a') }));
    queue.park('b', record('b', 'change', { retry: flaky('b') }));

    await jest.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['retry a']);
    // Doubled each failed pass: 2 s, 4 s, then the 8 s cap.
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);
    await jest.advanceTimersByTimeAsync(8000);
    expect(log).toEqual(['retry a', 'retry a', 'retry a', 'retry a']);
    available = true;
    await jest.advanceTimersByTimeAsync(8000);

    expect(log).toEqual(['retry a', 'retry a', 'retry a', 'retry a', 'retry a', 'retry b']);
    expect(queue.size).toBe(0);
  });

  it('counts an error of its own against one record, which is given up on after three, and settles the others', async () => {
    const queue = new RecoveryQueue(options());
    const refused = record('refused', 'change', { retry: () => Promise.reject(new Error('invalid byte sequence')) });
    queue.park('refused', refused);
    queue.park('b', record('b'));

    await queue.flush();
    expect(log).toEqual(['retry b']);
    for (let pass = 1; pass < RECOVERY_MAX_RECORD_FAILURES; pass++) await queue.flush();

    expect(refused.lostAs).toBe('failures');
    expect(queue.size).toBe(0);
  });

  it('keeps a record whose retry is not finished for the next pass', async () => {
    const queue = new RecoveryQueue(options());
    let finished = false;
    queue.park('a', record('a', 'change', { retry: () => Promise.resolve(finished) }));

    await queue.flush();
    expect(queue.size).toBe(1);
    finished = true;
    await jest.advanceTimersByTimeAsync(1000);
    expect(queue.size).toBe(0);
  });

  it('gives up on the oldest of a full lane', () => {
    const queue = new RecoveryQueue(options());
    const first = record('first');
    queue.park('first', first);
    for (const name of ['b', 'c', 'd']) queue.park(name, record(name));

    expect(first.lostAs).toBe('count');
    expect(queue.size).toBe(3);
  });

  it('gives up on the oldest records, whatever their lane, once the shared byte budget is spent', () => {
    const queue = new RecoveryQueue(options());
    const old = record('old', 'dispatch', { bytes: 600 });
    queue.park('old', old);
    queue.park('new', record('new', 'change', { bytes: 600 }));

    expect(old.lostAs).toBe('bytes');
    expect(queue.get('change', 'new')).toBeDefined();
  });

  it('keeps the place of a record kept again under its key, and gives up on the first kept when its lane is full', () => {
    const queue = new RecoveryQueue(options());
    const [a, b, c] = ['a', 'b', 'c'].map(name => record(name));
    queue.park('a', a);
    queue.park('b', b);
    queue.park('c', c);
    queue.park('a', a);
    queue.park('d', record('d'));
    queue.park('e', record('e'));

    expect(log).toEqual(['lost a count', 'lost b count']);
    expect(queue.get('change', 'c')).toBe(c);
  });

  it('counts a record against the byte budget as it was last measured', async () => {
    const queue = new RecoveryQueue(options());
    let size = 600;
    const shrinking = record('shrinking', 'change', { bytes: 0, retry: () => ((size = 100), Promise.resolve(false)) });
    shrinking.bytes = () => size;
    queue.park('shrinking', shrinking);
    // A try that wrote part of it leaves it smaller.
    await queue.flush();
    queue.park('b', record('b', 'dispatch', { bytes: 600 }));
    expect(log).toEqual([]);

    // Grown again (another change kept in it), and measured again.
    size = 500;
    queue.remeasure('change', 'shrinking');

    expect(log).toEqual(['lost shrinking bytes']);
    expect(queue.size).toBe(1);
    queue.park('c', record('c', 'send', { bytes: 300 }));
    expect(log).toEqual(['lost shrinking bytes']);
  });

  it('never gives up a record the age cap does not apply to for bytes, and gives up the oldest of the others', () => {
    const queue = new RecoveryQueue(options({ maxBytes: 1000 }));
    const revoke = record('revoke', 'change', { bytes: 200, ageCapped: false });
    queue.park('revoke', revoke);
    for (const name of ['a', 'b', 'c']) queue.park(name, record(name, 'dispatch', { bytes: 400 }));

    expect(log).toEqual(['lost a bytes']);
    expect(queue.get('change', 'revoke')).toBe(revoke);
  });

  it('gives up a record for bytes once the age cap applies to it again, as it was last measured', () => {
    const queue = new RecoveryQueue(options({ maxBytes: 1000 }));
    let capped = false;
    const changing = record('changing', 'change', { bytes: 300 });
    changing.ageCapped = () => capped;
    queue.park('changing', changing);
    queue.park('a', record('a', 'dispatch', { bytes: 400 }));
    // An edit kept with the revoke: what the record holds is content again.
    capped = true;
    queue.remeasure('change', 'changing');
    queue.park('b', record('b', 'dispatch', { bytes: 400 }));

    expect(log).toEqual(['lost a bytes']);
  });

  it('gives up on a record past its age cap, and keeps one the cap does not apply to', async () => {
    const queue = new RecoveryQueue(options());
    const aged = record('aged', 'change', { retry: () => Promise.resolve(false) });
    const revoke = record('revoke', 'change', { ageCapped: false, retry: () => Promise.resolve(false) });
    queue.park('aged', aged);
    queue.park('revoke', revoke);
    now += 60_001;

    await queue.flush();

    expect(aged.lostAs).toBe('age');
    expect(revoke.lostAs).toBeUndefined();
    expect(queue.get('change', 'revoke')).toBe(revoke);
  });

  it("drops a removed session's records without counting them lost, and a settled one", () => {
    const queue = new RecoveryQueue(options());
    const other = record('other');
    queue.park('a', record('a'));
    queue.park('other', other);
    queue.park('b', record('b'));

    queue.forget('s1');
    expect(queue.size).toBe(1);
    queue.settle('change', 'other');

    expect(queue.size).toBe(0);
    expect(log).toEqual([]);
  });

  it('makes one bounded pass at shutdown, logs what is left as lost, and keeps nothing after it', async () => {
    const queue = new RecoveryQueue(options());
    const kept = record('kept', 'change', { retry: () => Promise.reject(down()) });
    queue.park('a', record('a'));
    queue.park('kept', kept);

    await queue.drain(1000);
    const late = record('late');
    queue.park('late', late);

    expect(log).toEqual(['retry a', 'lost kept shutdown', 'lost late shutdown']);
    expect(queue.size).toBe(0);
  });

  it("drains only the lanes it is given, after every lane's outbox steps, and keeps the others going", async () => {
    const queue = new RecoveryQueue(options());
    const prepare = (name: string) => () => (log.push(`prepare ${name}`), Promise.resolve());
    queue.park(
      'c',
      record('c', 'change', { prepare: prepare('c'), retry: () => (log.push('retry c'), Promise.resolve(false)) }),
    );
    queue.park('d', record('d', 'dispatch', { retry: () => Promise.reject(down()) }));

    await queue.drain(1000, ['dispatch']);
    queue.park('late', record('late', 'dispatch'));

    expect(log).toEqual(['prepare c', 'lost d shutdown', 'lost late shutdown']);
    expect(queue.get('change', 'c')).toBeDefined();
    log.length = 0;
    // The database failed the dispatch: the next pass comes after twice the first delay, and tries the change.
    await jest.advanceTimersByTimeAsync(2000);
    expect(log).toEqual(['retry c']);
  });

  it('gives up on the first kept, across lanes, of records kept in the same millisecond', () => {
    const queue = new RecoveryQueue(options());
    const at = now;
    const first = record('first', 'dispatch', { bytes: 400 });
    const second = record('second', 'change', { bytes: 400 });
    Object.assign(first, { since: at });
    Object.assign(second, { since: at });
    queue.park('first', first);
    queue.park('second', second);
    queue.park('third', record('third', 'send', { bytes: 400 }));

    expect(log).toEqual(['lost first bytes']);
  });

  it('ends the shutdown pass at its budget', async () => {
    const queue = new RecoveryQueue(options());
    const hung = record('hung', 'change', { retry: () => new Promise<boolean>(() => undefined) });
    queue.park('hung', hung);

    const drained = queue.drain(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await drained;

    expect(hung.lostAs).toBe('shutdown');
  });

  it.each([
    ['a dropped connection', down(), true],
    ['SQLite busy', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), true],
    ['a disk I/O error', Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE' }), true],
    ['a full disk', { driverError: { code: 'SQLITE_FULL' } }, true],
    ['a refused value', Object.assign(new Error('invalid byte sequence'), { code: '22021' }), false],
    ['nothing', null, false],
  ])('reads %s as the database being away: %s', (_label, error, expected) => {
    expect(isDatabaseUnavailable(error)).toBe(expected);
  });
});

describe('RecoveryQueue with a journal', () => {
  let dir: string;
  let journal: RecoveryJournal;
  let log: string[];
  let now: number;
  const options = (over: Partial<RecoveryQueueOptions> = {}): RecoveryQueueOptions => ({
    maxBytes: 1000,
    maxRecords: { send: 10, change: 3, dispatch: 10 },
    maxAgeMs: { send: 60_000, change: 60_000, dispatch: 60_000 },
    baseDelayMs: 1000,
    capDelayMs: 8000,
    now: () => now,
    journal,
    ...over,
  });
  type Kept = RecoveryRecord & { name: string; held: string; lostAs?: RecoveryLoss };
  const kept = (name: string, lane: RecoveryLane = 'change', over: Partial<Kept> = {}): Kept => {
    const r: Kept = {
      name,
      held: name,
      lane,
      sessionId: 's1',
      since: now++,
      bytes: () => 1,
      ageCapped: () => true,
      retry: () => (log.push(`retry ${name}`), Promise.resolve(true)),
      lost: reason => {
        r.lostAs = reason;
        log.push(`lost ${name} ${reason}`);
      },
      ...over,
    };
    return r;
  };
  // Records held as `name` plus what they hold; one named `local…` is never journaled.
  const codec = (lane: RecoveryLane): RecoveryCodec => ({
    encode: record => {
      const r = record as Kept;
      return r.name.startsWith('local') ? undefined : { name: r.name, held: r.held, since: r.since };
    },
    decode: (_key, value) => {
      const v = value as { name: string; held: string; since: number };
      return v.name === 'refused' ? undefined : kept(v.name, lane, { held: v.held, since: v.since });
    },
  });
  const journaled = (): unknown[] =>
    readFileSync(journal.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as unknown);
  /** The process stops without its shutdown pass: what the file holds is all the next one finds. */
  const restart = (): RecoveryJournal => {
    journal.close();
    return (journal = new RecoveryJournal(journal.path));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'recovery-queue-journal-'));
    journal = new RecoveryJournal(join(dir, 'journal.jsonl'));
    log = [];
    now = 1_000_000;
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    journal.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('journals each record kept and what it holds as it changes, and forgets it once it settles', async () => {
    const queue = new RecoveryQueue(options());
    queue.register('change', codec('change'));
    const a = kept('a', 'change', { retry: () => Promise.resolve(false) });
    queue.park('a', a);
    a.held = 'a edited';
    queue.remeasure('change', 'a');
    queue.park('local', kept('local'));

    expect(journaled()).toEqual([
      { l: 'change', k: 'a', v: { name: 'a', held: 'a', since: 1_000_000 } },
      { l: 'change', k: 'a', v: { name: 'a', held: 'a edited', since: 1_000_000 } },
    ]);
    a.held = 'a written in part';
    await queue.flush();
    expect(restart().take('change')).toEqual([['a', { name: 'a', held: 'a written in part', since: 1_000_000 }]]);
  });

  it('restores what the last process kept, as it was, under every bound, before any pass', async () => {
    // Kept while the database was away, which it still is when the process stops.
    const first = new RecoveryQueue(options());
    first.register('change', codec('change'));
    first.register('dispatch', codec('dispatch'));
    const away = { retry: () => Promise.reject(down()) };
    for (const name of ['a', 'b', 'refused']) first.park(name, kept(name, 'change', away));
    first.park('d', kept('d', 'dispatch', away));
    restart();

    const queue = new RecoveryQueue(options({ maxRecords: { send: 10, change: 1, dispatch: 10 } }));
    queue.register('dispatch', codec('dispatch'));
    await queue.flush();
    await jest.advanceTimersByTimeAsync(5000);
    expect(log).toEqual([]);

    queue.register('change', codec('change'));
    // The lane's count cap gives up the oldest; the entry its owner refused is let go.
    expect(log).toEqual(['lost a count']);
    expect((queue.get('change', 'b') as Kept).since).toBe(1_000_001);
    await queue.flush();

    expect(log).toEqual(['lost a count', 'retry b', 'retry d']);
    expect(existsSync(journal.path) && readFileSync(journal.path, 'utf8')).toBe('');
  });

  it('gives up, once the application started, what the journal kept in a lane no owner took', async () => {
    const first = new RecoveryQueue(options());
    first.register('send', codec('send'));
    first.register('change', codec('change'));
    first.park('s', kept('s', 'send', { retry: () => Promise.reject(down()) }));
    first.park('c', kept('c', 'change', { retry: () => Promise.reject(down()) }));
    restart();

    const queue = new RecoveryQueue(options());
    queue.register('change', codec('change'));
    queue.ready();
    await queue.flush();

    expect(log).toEqual(['retry c']);
    expect(readFileSync(journal.path, 'utf8')).toBe('');
  });

  it.each([
    ['its lane is full', (queue: RecoveryQueue) => ['x', 'y', 'z'].forEach(name => queue.park(name, kept(name)))],
    [
      'it kept failing',
      async (queue: RecoveryQueue) => {
        for (let i = 0; i < RECOVERY_MAX_RECORD_FAILURES; i++) await queue.flush();
      },
    ],
    ['its session was removed', (queue: RecoveryQueue) => queue.forget('s1')],
    [
      'it is past its age',
      async (queue: RecoveryQueue) => {
        now += 120_000;
        await queue.flush();
      },
    ],
  ] as const)('forgets a record once %s', async (_label, cause) => {
    const queue = new RecoveryQueue(options());
    queue.register('change', codec('change'));
    queue.park('a', kept('a', 'change', { retry: () => Promise.reject(new Error('refused')) }));

    await cause(queue);

    expect(
      restart()
        .take('change')
        .map(([key]) => key),
    ).not.toContain('a');
  });

  it('keeps for the next start what the shutdown pass leaves, and what is kept after it', async () => {
    const queue = new RecoveryQueue(options());
    queue.register('change', codec('change'));
    queue.park('a', kept('a', 'change', { retry: () => Promise.reject(down()) }));
    queue.park('local', kept('local', 'change', { retry: () => Promise.reject(down()) }));

    await queue.drain(1000);
    queue.park('late', kept('late'));

    expect(log).toEqual(['lost local shutdown']);
    expect(
      restart()
        .take('change')
        .map(([key]) => key),
    ).toEqual(['a', 'late']);
  });

  it('loses what is kept after the shutdown pass when the journal cannot take it', async () => {
    const queue = new RecoveryQueue(options());
    queue.register('change', codec('change'));
    await queue.drain(1000);

    queue.park('local', kept('local'));

    expect(log).toEqual(['lost local shutdown']);
  });
});
