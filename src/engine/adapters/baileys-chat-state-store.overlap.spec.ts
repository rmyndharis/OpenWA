import { Repository } from 'typeorm';
import { ChatStateField, ChatStateStoreService, mergeTwinStates } from './baileys-chat-state-store.service';
import { ChatState } from './baileys-chat-state.entity';

const KEY = (s: string, c: string): string => `${s}\u0000${c}`;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

type Waiting = { name: string; key: string; apply: () => unknown; answer: (value: unknown) => void };

/**
 * A repository whose calls wait for the test. `start` applies the oldest waiting call of a kind (the nth,
 * or the oldest for one chat id) to the table at once and returns the function that hands its answer
 * back, so a read can run before a write and still be answered after it, as calls over pooled
 * connections can.
 */
function scriptedRepo(initial: Partial<ChatState>[] = []) {
  const rows = new Map<string, ChatState>();
  for (const r of initial) {
    const row = { muteEndTime: null, archived: false, pinned: false, observed: null, updatedAt: new Date(1), ...r };
    rows.set(KEY(r.sessionId!, r.chatId!), row as ChatState);
  }
  const waiting: Waiting[] = [];
  const answers: Array<() => void> = [];
  let stamp = 10;
  const issue = (name: string, key: string, apply: () => unknown) =>
    new Promise<unknown>(answer => waiting.push({ name, key, apply, answer }));
  const repo = {
    find: (opts?: { where?: { sessionId: string }; order?: { updatedAt?: 'DESC' }; take?: number }) =>
      issue('find', '*', () => {
        const found = [...rows.values()].filter(r => !opts?.where || r.sessionId === opts.where.sessionId);
        const at = (r: ChatState) => r.updatedAt?.getTime() ?? 0;
        if (opts?.order?.updatedAt === 'DESC') found.sort((a, b) => at(b) - at(a));
        return (opts?.take ? found.slice(0, opts.take) : found).map(r => ({ ...r }));
      }),
    findOne: ({ where }: { where: { sessionId: string; chatId: string } }) =>
      issue('findOne', where.chatId, () => {
        const r = rows.get(KEY(where.sessionId, where.chatId));
        return r ? { ...r } : undefined;
      }),
    upsert: (v: ChatState) =>
      issue('upsert', v.chatId, () => {
        const k = KEY(v.sessionId, v.chatId);
        rows.set(k, { ...rows.get(k), ...v, updatedAt: new Date(stamp++) });
      }),
    delete: ({ sessionId, chatId }: { sessionId: string; chatId?: string }) =>
      issue('delete', chatId ?? '*', () => {
        for (const [k, r] of rows)
          if (r.sessionId === sessionId && (chatId === undefined || r.chatId === chatId)) rows.delete(k);
      }),
  };
  const applyAt = (i: number): (() => void) => {
    const [call] = waiting.splice(i, 1);
    const value = call.apply();
    return () => call.answer(value);
  };
  /** Applies a waiting call of that kind now; the returned function hands its answer back. */
  const start = async (name: string, which: number | string = 0): Promise<() => Promise<void>> => {
    await settle();
    const match = (w: Waiting) => w.name === name && (typeof which === 'number' || w.key === which);
    const i =
      waiting.map((w, ix) => (match(w) ? ix : -1)).filter(ix => ix >= 0)[typeof which === 'number' ? which : 0] ?? -1;
    if (i < 0)
      throw new Error(`no waiting ${name} ${which}; waiting: ${waiting.map(w => `${w.name}:${w.key}`).join(',')}`);
    const answer = applyAt(i);
    return async () => {
      answer();
      await settle();
    };
  };
  const run = async (name: string, which: number | string = 0) => (await start(name, which))();
  /** Runs what is waiting, oldest first, until nothing is. */
  const drain = async () => {
    for (await settle(); waiting.length; await settle()) await run(waiting[0].name);
  };
  return { repo, rows, waiting, answers, applyAt, start, run, drain };
}

const storeOf = (t: ReturnType<typeof scriptedRepo>) =>
  new ChatStateStoreService(t.repo as unknown as Repository<ChatState>);

describe('ChatStateStoreService loads that overlap a write, a forget or an unlink', () => {
  const ENV = 'BAILEYS_CHAT_STATE_CACHE_MAX';
  const orig = process.env[ENV];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  const pinned = (chatId = 'c'): Partial<ChatState> => ({ sessionId: 's', chatId, pinned: true, observed: 'pinned' });

  it('does not bring a deleted chat back from a read-through begun before forget()', async () => {
    const t = scriptedRepo([pinned()]);
    const svc = storeOf(t);
    svc.get('s', 'c'); // a miss: the read-through starts
    const answer = await t.start('findOne'); // its SELECT runs while the row exists
    const forgotten = svc.forget('s', ['c']);
    await t.run('delete');
    await forgotten;
    await answer(); // and is answered after the delete
    expect(t.rows.size).toBe(0);
    expect(svc.chatIds('s')).toEqual([]);
    expect(svc.get('s', 'c')).toBeUndefined();
  });

  it('still writes the row of a chat pinned again after such a read-through', async () => {
    const t = scriptedRepo([pinned()]);
    const svc = storeOf(t);
    svc.get('s', 'c');
    const answer = await t.start('findOne');
    const forgotten = svc.forget('s', ['c']);
    await t.run('delete');
    await forgotten;
    await answer();
    const pin = svc.remember('s', 'c', { pinned: true }); // a new message re-created the chat, pinned again
    await t.drain();
    await pin;
    expect(t.rows.get(KEY('s', 'c'))?.pinned).toBe(true);
  });

  it('does not bring an unlinked account chat back from a read-through begun before clearSession()', async () => {
    const t = scriptedRepo([pinned()]);
    const svc = storeOf(t);
    svc.get('s', 'c');
    const answer = await t.start('findOne');
    const cleared = svc.clearSession('s');
    await t.run('delete');
    await cleared;
    await answer();
    expect(t.rows.size).toBe(0);
    expect(svc.chatIds('s')).toEqual([]);
  });

  it.each([
    ['reload', (svc: ChatStateStoreService) => svc.reload()],
    ['refreshSession', (svc: ChatStateStoreService) => svc.refreshSession('s')],
  ])('does not bring unlinked account chats back from a %s whose read ran before clearSession()', async (_n, load) => {
    const t = scriptedRepo([pinned()]);
    const svc = storeOf(t);
    const loading = load(svc);
    const answer = await t.start('find');
    const cleared = svc.clearSession('s');
    await t.run('delete');
    await cleared;
    await answer();
    await loading;
    expect(t.rows.size).toBe(0);
    expect(svc.chatIds('s')).toEqual([]);
  });

  it('does not list a deleted chat from a refresh whose read ran before forget()', async () => {
    const t = scriptedRepo([pinned()]);
    const svc = storeOf(t);
    const refresh = svc.refreshSession('s');
    const forgotten = svc.forget('s', ['c']);
    const answer = await t.start('find'); // the snapshot still holds the row
    await t.run('delete');
    await forgotten;
    await answer();
    await refresh;
    expect(t.rows.size).toBe(0);
    expect(svc.chatIds('s')).toEqual([]);
  });

  describe.each([
    ['reload', (svc: ChatStateStoreService) => svc.reload()],
    ['refreshSession', (svc: ChatStateStoreService) => svc.refreshSession('s')],
  ])('a %s whose read ran before a write landed', (_name, load) => {
    // The write reads the row and caches its change, the load reads the table (still pinned), then the
    // write lands and the load's older rows are handed back.
    const unpinWhileLoading = async () => {
      const t = scriptedRepo([{ ...pinned(), muteEndTime: 99, observed: 'muteEndTime,pinned' }]);
      const svc = storeOf(t);
      const unpin = svc.remember('s', 'c', { pinned: false });
      const loading = load(svc);
      await t.run('findOne');
      const answer = await t.start('find');
      await t.run('upsert');
      await unpin;
      await answer();
      await loading;
      return { t, svc };
    };

    it('never serves the older row over the written state', async () => {
      const { t, svc } = await unpinWhileLoading();
      expect(t.rows.get(KEY('s', 'c'))?.pinned).toBe(false);
      expect(svc.get('s', 'c')?.pinned).not.toBe(true);
      await t.drain(); // a cold read warms from the table
      expect(svc.get('s', 'c')).toMatchObject({ pinned: false, muteEndTime: 99 });
    });

    it('lets the next partial write merge onto the written state', async () => {
      const { t, svc } = await unpinWhileLoading();
      const archive = svc.remember('s', 'c', { archived: true });
      await t.drain();
      await archive;
      expect(t.rows.get(KEY('s', 'c'))).toMatchObject({ archived: true, pinned: false, muteEndTime: 99 });
    });
  });

  it('does not mark a stored chat absent from a no-row answer taken before its write', async () => {
    const t = scriptedRepo();
    const svc = storeOf(t);
    svc.get('s', 'c'); // a read-through for a chat with no row yet
    const write = svc.remember('s', 'c', { archived: true });
    const reload = svc.reload();
    const noRow = await t.start('findOne'); // the read-through finds nothing
    await t.run('findOne'); // the write finds nothing either and caches its change
    const snapshot = await t.start('find'); // the reload reads an empty table
    await t.run('upsert');
    await write;
    await snapshot();
    await reload;
    await noRow(); // the old no-row answer arrives last
    svc.get('s', 'c'); // a cold read must warm from the table, not trust an absent mark
    await t.drain();
    expect(svc.get('s', 'c')?.archived).toBe(true);
  });

  describe('a fold of a chat and a write of its twin', () => {
    const P = 'p@s.whatsapp.net';
    const L = 'l@lid';
    /** The chat as a listing reads it: its rows merged field by field. */
    const view = (t: ReturnType<typeof scriptedRepo>) =>
      mergeTwinStates(
        [...t.rows.values()].map(r => ({
          muteEndTime: r.muteEndTime,
          archived: r.archived,
          pinned: r.pinned,
          updatedAt: r.updatedAt?.getTime(),
          observed: r.observed == null ? undefined : (r.observed.split(',').filter(Boolean) as ChatStateField[]),
        })),
      );

    it('does not leave a written twin chat hidden behind a no-row answer a fold read before its write', async () => {
      const t = scriptedRepo();
      const svc = storeOf(t);
      const fold = svc.fold('s', P, [L], { archived: true });
      const write = svc.remember('s', L, { pinned: true });
      const reload = svc.reload();
      const snapshot = await t.start('find'); // the reload reads the empty table
      await t.run('findOne', P); // the fold reads its own chat: no row
      await t.run('findOne', L); // then its twin: no row, and the write of the twin waits for the fold
      await snapshot();
      await reload;
      await t.drain();
      await Promise.all([fold, write]);
      expect(t.rows.get(KEY('s', L))?.pinned).toBe(true);
      svc.get('s', L); // a chat list read must warm from the table, not trust an absent mark
      await t.drain();
      expect(svc.get('s', L)?.pinned).toBe(true);
    });

    it('keeps what a fold merged when a write of the twin in the same tick changes nothing', async () => {
      const all = 'muteEndTime,archived,pinned';
      const t = scriptedRepo([
        { sessionId: 's', chatId: P, muteEndTime: 1234, observed: all, updatedAt: new Date(2) },
        { sessionId: 's', chatId: L, muteEndTime: 555, archived: true, observed: all, updatedAt: new Date(3) },
      ]);
      const svc = storeOf(t);
      const fold = svc.fold('s', P, [L], { pinned: true });
      const write = svc.remember('s', L, { archived: true }); // already archived
      await t.drain();
      await Promise.all([fold, write]);
      expect(view(t)).toMatchObject({ muteEndTime: 555, archived: true, pinned: true });
    });

    it('keeps a write of the twin that starts after the fold read the twin', async () => {
      const t = scriptedRepo([{ sessionId: 's', chatId: L, muteEndTime: 1234, observed: 'muteEndTime' }]);
      const svc = storeOf(t);
      const fold = svc.fold('s', P, [L], { archived: true });
      await t.run('findOne', P);
      await t.run('findOne', L); // the fold has read the twin, muted until 1234
      const write = svc.remember('s', L, { muteEndTime: 1001 });
      await t.drain();
      await Promise.all([fold, write]);
      expect(view(t)).toMatchObject({ muteEndTime: 1001, archived: true });
    });

    it.each([
      ['has a row', [{ sessionId: 's', chatId: L, archived: false, observed: 'archived', updatedAt: new Date(5) }]],
      ['has no row', []],
    ])('keeps a pin of the twin issued while the fold reads the twin, which %s', async (_name, twinRows) => {
      const t = scriptedRepo([
        { sessionId: 's', chatId: P, pinned: false, observed: 'pinned', updatedAt: new Date(3) },
        ...twinRows,
      ]);
      const svc = storeOf(t);
      const fold = svc.fold('s', P, [L], { muteEndTime: 5000 });
      await t.run('findOne', P);
      const twinRead = await t.start('findOne', L); // the twin is read, its answer is still out
      const write = svc.remember('s', L, { pinned: true });
      await twinRead();
      await t.drain();
      await Promise.all([fold, write]);
      expect(view(t)).toMatchObject({ pinned: true, muteEndTime: 5000 });
    });

    it('counts the twin of a fold as changing only until the fold ends', async () => {
      const t = scriptedRepo();
      const svc = storeOf(t);
      const fold = svc.fold('s', P, [L], { archived: true });
      await t.drain();
      await fold;
      const pin = svc.remember('s', L, { pinned: true });
      await t.drain();
      await pin;
      const reload = svc.reload();
      await t.drain();
      await reload;
      expect(svc.get('s', L)?.pinned).toBe(true); // a reload sets aside the row of a chat still changing
    });

    it("lets folds that name each other's chat as a twin, or one twin twice, all finish", async () => {
      const t = scriptedRepo([{ sessionId: 's', chatId: L, pinned: true, observed: 'pinned' }]);
      const svc = storeOf(t);
      let finished = false;
      void Promise.all([
        svc.fold('s', P, [L], { archived: true }),
        svc.fold('s', L, [P], { muteEndTime: 1 }),
        svc.fold('s', P, [L, L], { pinned: true }),
      ]).then(() => (finished = true));
      await t.drain(); // answers every query the folds make: one still waiting after that waits forever
      await settle();
      expect(finished).toBe(true);
      expect(view(t)).toMatchObject({ pinned: true, archived: true, muteEndTime: 1 });
    });
  });

  it('does not index an older read-through answer once cache pressure evicted the written chat', async () => {
    process.env[ENV] = '2';
    const t = scriptedRepo([{ ...pinned(), muteEndTime: 99, observed: 'muteEndTime,pinned' }]);
    const svc = storeOf(t);
    const unmute = svc.remember('s', 'c', { muteEndTime: null });
    svc.get('s', 'c'); // a chat-list read starts a read-through, queued before the write's own read
    await t.run('findOne', 1); // the write reads the row and caches its change
    const olderAnswer = await t.start('findOne'); // the read-through runs before the write lands: mute still 99
    await t.run('upsert');
    await unmute;
    for (const other of ['x', 'y']) {
      // two other chats fill the cap and evict the written one
      const w = svc.remember('s', other, { pinned: true });
      await t.drain();
      await w;
    }
    await olderAnswer();
    const unpin = svc.remember('s', 'c', { pinned: false }); // a partial patch for the chat
    await t.drain();
    await unpin;
    expect(t.rows.get(KEY('s', 'c'))).toMatchObject({ pinned: false, muteEndTime: null });
  });

  it('does not mark a session complete when a reload set aside the row of a write that changed nothing', async () => {
    const t = scriptedRepo([pinned()]);
    const svc = storeOf(t);
    const first = svc.reload();
    await t.run('find');
    await first; // the session is complete and holds the row
    expect(svc.get('s', 'c')?.pinned).toBe(true);
    const second = svc.reload();
    const answer = await t.start('find'); // its read is out
    await svc.remember('s', 'c', { pinned: true }); // restates the state: settles, writes nothing
    await settle();
    await answer(); // the reload sets the row of c aside as older than that change
    await second;
    expect(t.waiting).toHaveLength(0);
    svc.get('s', 'c'); // a miss on a session not marked complete reads through
    await t.drain();
    expect(svc.get('s', 'c')?.pinned).toBe(true);
  });

  it('does not bring an unlinked account chat back from a reload begun while the unlink was deleting', async () => {
    const t = scriptedRepo([pinned('a')]);
    const svc = storeOf(t);
    const unlink = svc.clearSession('s');
    await settle(); // the delete is submitted
    const reload = svc.reload(); // begins after the unlink did
    const answer = await t.start('find'); // reads the row: the delete has not run yet
    await t.run('delete'); // the unlink deletes, drops the cache and notes the unlink
    await unlink;
    await answer();
    await reload;
    expect(t.rows.size).toBe(0);
    expect(svc.chatIds('s')).toEqual([]);
  });

  it('distrusts a chat whose change was dropped from a record of changes that was full', async () => {
    process.env[ENV] = '2';
    const t = scriptedRepo([pinned('A')]);
    const svc = storeOf(t);
    const writeX = svc.remember('s', 'X', { pinned: true });
    await t.drain();
    await writeX; // one chat is on record before the load
    const reload = svc.reload();
    const answer = await t.start('find'); // the load reads A pinned
    const writeA = svc.remember('s', 'A', { pinned: false });
    await t.drain();
    await writeA; // A changed after the load began: on record, which is now full
    const writeB = svc.remember('s', 'B', { pinned: true });
    await t.drain();
    await writeB; // the full record is dropped, A with it
    await answer();
    await reload;
    expect(t.rows.get(KEY('s', 'A'))?.pinned).toBe(false);
    expect(svc.get('s', 'A')?.pinned).not.toBe(true);
  });

  it('stays correct when more chats change during a load than the store keeps a record of', async () => {
    process.env[ENV] = '2';
    const t = scriptedRepo([pinned('a')]);
    const svc = storeOf(t);
    const refresh = svc.refreshSession('s');
    const snapshot = await t.start('find'); // the snapshot holds a, pinned
    for (const [chat, patch] of [
      ['a', { pinned: false }],
      ['x', { pinned: true }],
      ['y', { pinned: true }],
    ] as const) {
      const w = svc.remember('s', chat, patch);
      await t.drain();
      await w;
    }
    await snapshot();
    await refresh;
    expect(t.rows.get(KEY('s', 'a'))?.pinned).toBe(false);
    expect(svc.get('s', 'a')?.pinned).not.toBe(true);
  });
});

// A seeded scheduler: every repository call is run and answered in an order drawn from the seed, and
// the table (and, once everything has settled, the cache) is compared with a model of what the
// operations should have left.
describe('ChatStateStoreService under a seeded interleaving of loads and writes', () => {
  const ENV = 'BAILEYS_CHAT_STATE_CACHE_MAX';
  const orig = process.env[ENV];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  // The ops below never mark a deletion, so the model leaves that field out.
  const FIELDS: Exclude<ChatStateField, 'deletedAt'>[] = ['muteEndTime', 'archived', 'pinned'];
  const SESSIONS = ['s1', 's2'];
  const CHATS = ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@g.us'];
  type Patch = { muteEndTime?: number | null; archived?: boolean; pinned?: boolean };
  type Op =
    | { t: 'remember'; s: string; c: string; patch: Patch; create: boolean }
    | { t: 'forget' | 'get'; s: string; c: string }
    | { t: 'refresh'; s: string }
    | { t: 'reload' };
  type Modelled = { muteEndTime: number | null; archived: boolean; pinned: boolean; observed: Set<string> };

  const mulberry32 = (seed: number) => {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const generate = (rand: () => number, kinds: Array<Op['t']>): Op[] => {
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    return Array.from({ length: 6 + Math.floor(rand() * 10) }, (): Op => {
      const t = pick(kinds);
      const s = pick(SESSIONS);
      const c = pick(CHATS);
      if (t === 'refresh') return { t, s };
      if (t === 'reload') return { t };
      if (t !== 'remember') return { t, s, c };
      const patch: Patch = {};
      if (rand() < 0.5) patch.pinned = rand() < 0.5;
      if (rand() < 0.4) patch.archived = rand() < 0.5;
      if (rand() < 0.3) patch.muteEndTime = rand() < 0.5 ? null : 1000 + Math.floor(rand() * 5);
      if (!Object.keys(patch).length) patch.pinned = rand() < 0.5;
      return { t, s, c, patch, create: rand() < 0.5 };
    });
  };

  /** What `remember` should leave in the table: the patch merged onto the row, unless it changes nothing. */
  const modelRemember = (model: Map<string, Modelled>, s: string, c: string, patch: Patch, create: boolean) => {
    const row = model.get(KEY(s, c));
    const carried = FIELDS.filter(f => Object.hasOwn(patch, f));
    if (!row && !create && carried.every(f => patch[f] === { muteEndTime: null, archived: false, pinned: false }[f]))
      return;
    const base = row ?? { muteEndTime: null, archived: false, pinned: false, observed: new Set<string>() };
    const observed = new Set([...base.observed, ...carried]);
    const next = { ...base, ...patch, observed };
    const same = FIELDS.every(f => next[f] === base[f]) && observed.size === base.observed.size;
    if (!same) model.set(KEY(s, c), next);
  };

  const describeTable = (rows: Iterable<ChatState>): string[] =>
    [...rows]
      .map(
        r =>
          `${r.sessionId}|${r.chatId}|${r.muteEndTime}|${r.archived}|${r.pinned}|${(r.observed ?? '').split(',').filter(Boolean).sort().join(',')}`,
      )
      .sort();

  const runScript = async (kinds: Array<Op['t']>, cap: number, seed: number): Promise<string[]> => {
    process.env[ENV] = String(cap);
    const rand = mulberry32(seed * 104729);
    const preload =
      rand() < 0.5
        ? [
            { s: 's1', c: CHATS[0] },
            { s: 's2', c: CHATS[1] },
          ]
        : [];
    const ops = generate(rand, kinds);
    const model = new Map<string, Modelled>();
    const t = scriptedRepo(
      preload.map(p => ({
        sessionId: p.s,
        chatId: p.c,
        muteEndTime: 99,
        pinned: true,
        observed: 'muteEndTime,pinned',
      })),
    );
    for (const p of preload) {
      model.set(KEY(p.s, p.c), {
        muteEndTime: 99,
        archived: false,
        pinned: true,
        observed: new Set(['muteEndTime', 'pinned']),
      });
    }
    const svc = storeOf(t);
    const issued: Promise<unknown>[] = [];
    const settleAll = async () => {
      for (await settle(); t.waiting.length || t.answers.length; await settle()) {
        if (t.waiting.length) t.answers.push(t.applyAt(Math.floor(rand() * t.waiting.length)));
        else t.answers.splice(Math.floor(rand() * t.answers.length), 1)[0]();
      }
    };
    let next = 0;
    while (next < ops.length || t.waiting.length || t.answers.length) {
      await settle();
      const choices = [
        ...(next < ops.length ? ['issue', 'issue'] : []),
        ...(t.waiting.length ? ['apply'] : []),
        ...(t.answers.length ? ['answer'] : []),
      ];
      const choice = choices[Math.floor(rand() * choices.length)];
      if (choice === 'apply') t.answers.push(t.applyAt(Math.floor(rand() * t.waiting.length)));
      else if (choice === 'answer') t.answers.splice(Math.floor(rand() * t.answers.length), 1)[0]();
      else {
        const op = ops[next++];
        if (op.t === 'remember') {
          modelRemember(model, op.s, op.c, op.patch, op.create);
          issued.push(svc.remember(op.s, op.c, op.patch, op.create));
        } else if (op.t === 'forget') {
          model.delete(KEY(op.s, op.c));
          issued.push(svc.forget(op.s, [op.c]));
        } else if (op.t === 'get') svc.get(op.s, op.c);
        else issued.push(op.t === 'refresh' ? svc.refreshSession(op.s) : svc.reload());
      }
    }
    await settleAll();
    await Promise.all(issued);
    const problems: string[] = [];
    const expected = describeTable(
      [...model].map(([k, v]) => {
        const [sessionId, chatId] = k.split('\u0000');
        return { sessionId, chatId, ...v, observed: [...v.observed].join(',') } as unknown as ChatState;
      }),
    );
    if (JSON.stringify(describeTable(t.rows.values())) !== JSON.stringify(expected)) {
      problems.push(`table ${JSON.stringify(describeTable(t.rows.values()))} but expected ${JSON.stringify(expected)}`);
    }
    if (cap === 0 || cap >= 100) {
      // Once settled, a read warmed from the table answers what the table holds.
      for (const s of SESSIONS) for (const c of CHATS) svc.get(s, c);
      await settleAll();
      for (const s of SESSIONS) {
        for (const c of CHATS) {
          const row = t.rows.get(KEY(s, c));
          const got = svc.get(s, c);
          const want = row && [row.muteEndTime, row.archived, row.pinned];
          if (JSON.stringify(got && [got.muteEndTime, got.archived, got.pinned]) !== JSON.stringify(want)) {
            problems.push(`cache of ${s}/${c} is ${JSON.stringify(got)} but the table holds ${JSON.stringify(row)}`);
          }
        }
      }
    }
    return problems.map(p => `seed ${seed} ${p}\n  ops ${JSON.stringify(ops)}\n  preload ${JSON.stringify(preload)}`);
  };

  it.each([
    ['writes, forgets and reads', ['remember', 'remember', 'remember', 'forget', 'get'] as Array<Op['t']>, 5000],
    ['and a refresh', ['remember', 'remember', 'remember', 'forget', 'get', 'refresh'] as Array<Op['t']>, 5000],
    ['and a reload', ['remember', 'remember', 'remember', 'forget', 'get', 'reload'] as Array<Op['t']>, 5000],
    ['under cache pressure', ['remember', 'remember', 'forget', 'get', 'refresh', 'reload'] as Array<Op['t']>, 2],
  ])(
    'leaves the table as the operations imply: %s',
    async (_name, kinds, cap) => {
      const problems: string[] = [];
      for (let seed = 1; seed <= 600; seed++) problems.push(...(await runScript(kinds, cap, seed)));
      expect({ failing: problems.length, first: problems.slice(0, 2) }).toEqual({ failing: 0, first: [] });
    },
    60_000,
  );
});
