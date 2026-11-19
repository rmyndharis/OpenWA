import { DataSource, Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionService } from './session.service';

/**
 * Claims of one session that overlap on a node, over a real SQLite database whose statements are held in two stages:
 * when a statement executes and when its caller sees the answer. A schedule is the order in which the held stages are
 * let through, so an interleaving that a request pair meets once in a million is replayed exactly, and every schedule
 * of two claims is walked. The row is one a node whose lease lapsed held, which the claims take over.
 */
interface Gate {
  label: string;
  stage: 'exec' | 'reply';
  release: () => void;
}

const labelOf = (sql: string, params: unknown): string => {
  const text = sql.replace(/\s+/g, ' ');
  if (/^UPDATE/i.test(text)) {
    if (/"updatedAt" = "updatedAt"/.test(text)) return 'lock';
    // The claim sets the row's owner and the release clears it.
    if (/"claimedAt"/.test(text) && /"nodeUrl"/.test(text))
      return Array.isArray(params) && params[0] === null ? 'release' : 'write';
    return 'renew';
  }
  return /^SELECT/i.test(text) ? 'select' : text.split(' ')[0].toLowerCase();
};

type Query = (...args: unknown[]) => Promise<unknown>;

function gateStatements(dataSource: DataSource) {
  const runner = dataSource.createQueryRunner();
  const proto = Object.getPrototypeOf(runner) as { query: Query };
  void runner.release();
  const original = proto.query;
  const gates = { enabled: false, waiting: [] as Gate[], passThrough: new Set<string>() };
  const hold = (label: string, stage: Gate['stage']): Promise<void> =>
    new Promise<void>(release => gates.waiting.push({ label, stage, release }));
  proto.query = async function patched(this: unknown, ...args: unknown[]): Promise<unknown> {
    const label = labelOf(String(args[0]), args[1]);
    if (!gates.enabled || gates.passThrough.has(label)) return original.apply(this, args);
    await hold(label, 'exec');
    const answer = await original.apply(this, args).then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    );
    await hold(label, 'reply');
    if ('error' in answer) throw answer.error;
    return answer.value;
  };
  return { gates, restore: (): void => void (proto.query = original) };
}

const settle = async (rounds = 3): Promise<void> => {
  for (let round = 0; round < rounds; round++) await new Promise<void>(resolve => setImmediate(resolve));
};

type Internals = { claimGen: Map<string, number>; latestClaim: Map<string, Promise<boolean>>; owned: Set<string> };

interface Claim {
  label: string;
  done: boolean;
  answer?: boolean | 'threw';
}

describe('claims of one session that overlap on a node', () => {
  let dataSource: DataSource;
  let sessions: Repository<Session>;
  let held: ReturnType<typeof gateStatements>;

  let warn: jest.SpyInstance;

  beforeAll(async () => {
    // Every refused claim of a walk logs that another node holds the session.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    });
    await dataSource.initialize();
    sessions = dataSource.getRepository(Session);
    held = gateStatements(dataSource);
  });

  afterAll(async () => {
    held.restore();
    warn.mockRestore();
    await dataSource.destroy();
  });

  const config = (nodeId: string) =>
    ({ get: (key: string) => ({ 'session.nodeId': nodeId, 'session.leaseTtlMs': 60_000 })[key] }) as never;

  const lapsedPeer = (): Partial<Session> => ({
    nodeId: 'node-b',
    claimedAt: new Date(Date.now() - 120_000),
    leaseExpiresAt: new Date(Date.now() - 60_000),
  });
  const livePeer = (): Partial<Session> => ({
    nodeId: 'node-b',
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const freeRow = (): Partial<Session> => ({});
  const heldByNode = (): Partial<Session> => ({
    nodeId: 'node-a',
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });

  interface Run {
    schedule: string[];
    followUps: number;
    onClaimed: string[];
    problems: string[];
    answers: Array<boolean | 'threw' | undefined>;
  }

  /** What a claim asks of the node: the service's claim, or what a start and a delete make of it. */
  type Ask = (node: SessionOwnershipService, id: string, onClaimed: (owns: () => boolean) => void) => Promise<boolean>;
  const claimAsk: Ask = (node, id, onClaimed) => node.claim(id, onClaimed);

  /** What this node did with the session before the claims begin. */
  interface Setup {
    /** A claim of its own settled earlier, so the node holds the row in memory too. */
    holds?: boolean;
    /** Releases of the session that begin just before the claims: their statements are held like the claims'. */
    releases?: number;
    /** The releases are the one a node makes of everything it holds on its way down. */
    shutdown?: boolean;
    /** The releases begin once this many stages were let through, not before the claims: they interrupt a claim. */
    releaseAt?: number;
    /** The last claim begins once no more than this many of the releases are still under way. */
    lastClaimWhenReleasing?: number;
  }

  /**
   * One schedule: `claims` claims begin together and `pick` chooses which held statement stage goes next. Returns what
   * the follow-up handler and the claims' callbacks saw, the schedule taken and the choices each step had.
   */
  async function play(
    row: Partial<Session>,
    claims: number,
    transactional: boolean,
    pick: (choices: Gate[], step: number, state: { releasing: number }) => number,
    ask: Ask = claimAsk,
    setup: Setup = {},
  ): Promise<Run & { taken: number[]; choices: number[] }> {
    await sessions.clear();
    const node = new SessionOwnershipService(sessions, config('node-a'));
    const saved = await sessions.save(
      sessions.create({ name: 'overlap', status: SessionStatus.READY, config: {}, ...row }),
    );
    let followUps = 0;
    node.onAdoption(() => {
      followUps++;
      return Promise.resolve();
    }, transactional);
    const lost: string[][] = [];
    node.onLeaseLoss(ids => void lost.push(ids));
    if (setup.holds) await node.claim(saved.id);
    const onClaimed: Array<{ label: string; owns: () => boolean }> = [];
    const answers: Claim[] = [];
    const problems: string[] = [];
    held.gates.waiting = [];
    held.gates.passThrough = transactional ? new Set(['begin', 'commit', 'rollback']) : new Set();
    held.gates.enabled = true;
    let releasing = setup.releases ?? 0;
    const startReleases = (): void => {
      for (let at = 0; at < (setup.releases ?? 0); at++) {
        void (setup.shutdown ? node.releaseAll() : node.release(saved.id)).then(
          () => void releasing--,
          () => void (releasing--, problems.push('a release threw')),
        );
      }
    };
    const startClaim = (at: number): void => {
      const label = String.fromCharCode(65 + at);
      const claim: Claim = { label, done: false };
      answers.push(claim);
      void ask(node, saved.id, owns => onClaimed.push({ label, owns })).then(
        answer => void ((claim.answer = answer), (claim.done = true)),
        () => void ((claim.answer = 'threw'), (claim.done = true)),
      );
    };
    // What begins later in the schedule: when its turn comes, or at once when no statement is held to let through.
    const later: Array<{ due: (step: number) => boolean; start: () => void }> = [];
    const finished = (): boolean => releasing === 0 && later.length === 0 && answers.every(claim => claim.done);
    if (setup.releaseAt === undefined) startReleases();
    else later.push({ due: step => step >= setup.releaseAt!, start: startReleases });
    for (let at = 0; at < claims; at++) {
      if (at === claims - 1 && setup.lastClaimWhenReleasing !== undefined) {
        later.push({ due: () => releasing <= setup.lastClaimWhenReleasing!, start: () => startClaim(at) });
      } else startClaim(at);
    }
    const schedule: string[] = [];
    const taken: number[] = [];
    const choices: number[] = [];
    for (let step = 0; step < 600; step++) {
      await settle();
      for (
        let next = later.findIndex(op => op.due(step) || held.gates.waiting.length === 0);
        next >= 0;
        next = later.findIndex(op => op.due(step) || held.gates.waiting.length === 0)
      ) {
        later.splice(next, 1)[0].start();
        await settle();
      }
      if (held.gates.waiting.length === 0) {
        if (finished()) break;
        // A claim with no statement held is waiting for the transaction another claim has open to end, or for a release.
        const deadline = Date.now() + 10_000;
        while (held.gates.waiting.length === 0 && !finished() && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        await settle();
        if (held.gates.waiting.length === 0) {
          if (!finished()) problems.push('a claim or a release never settled');
          break;
        }
      }
      const at = pick(held.gates.waiting, step, { releasing });
      if (at < 0) {
        // The schedule lets nothing through yet: what is under way elsewhere shows its next statement shortly.
        await new Promise(resolve => setTimeout(resolve, 2));
        continue;
      }
      choices.push(held.gates.waiting.length);
      taken.push(at);
      const [gate] = held.gates.waiting.splice(at, 1);
      schedule.push(`${gate.label}:${gate.stage}`);
      gate.release();
    }
    while (held.gates.waiting.length > 0) {
      held.gates.waiting.shift()!.release();
      await settle();
    }
    await settle();
    held.gates.enabled = false;

    const internals = node as unknown as Internals;
    const final = await sessions.findOneByOrFail({ id: saved.id });
    const isOwned = internals.owned.has(saved.id);
    if (isOwned !== internals.claimGen.has(saved.id)) problems.push('owned and claimGen disagree');
    if (internals.latestClaim.size !== 0) problems.push('a claim in flight was left registered');
    if (isOwned && final.nodeId !== 'node-a') problems.push(`owned, but the row names ${final.nodeId}`);
    if (isOwned && !(final.claimedAt && final.leaseExpiresAt && final.leaseExpiresAt.getTime() > Date.now()))
      problems.push('owned, but the row carries no live claim');
    if (lost.length > 0) problems.push('a lease loss was reported');
    for (const { label, owns } of onClaimed) if (!owns()) problems.push(`the claim captured by ${label} reads as lost`);
    // Nothing but a peer's live lease makes a claim answer false, however many of them overlap.
    const peerHolds = row.nodeId != null && row.nodeId !== 'node-a' && row.leaseExpiresAt!.getTime() > Date.now();
    for (const { label, answer } of answers) {
      if (answer !== !peerHolds)
        problems.push(`claim ${label} answered ${answer} with ${peerHolds ? 'a' : 'no'} live peer`);
    }
    if (claims > 0 && !peerHolds && !isOwned) problems.push('every claim answered true and this node holds nothing');
    return {
      schedule,
      followUps,
      onClaimed: onClaimed.map(one => one.label),
      problems,
      answers: answers.map(claim => claim.answer),
      taken,
      choices,
    };
  }

  /** Every schedule of the claims, depth first: each step that had a choice is walked with every alternative. */
  async function walk(
    row: () => Partial<Session>,
    claims: number,
    transactional: boolean,
    setup: Setup = {},
  ): Promise<Run[]> {
    const runs: Run[] = [];
    const pending: number[][] = [[]];
    while (pending.length > 0) {
      const prefix = pending.pop()!;
      const run = await play(
        row(),
        claims,
        transactional,
        (_choices, step) => (step < prefix.length ? prefix[step] : 0),
        claimAsk,
        setup,
      );
      runs.push(run);
      for (let step = prefix.length; step < run.choices.length; step++) {
        for (let other = 1; other < run.choices[step]; other++) pending.push([...run.taken.slice(0, step), other]);
      }
    }
    return runs;
  }

  /** Seeded schedules, for claim counts too large to walk. */
  async function sample(
    row: () => Partial<Session>,
    claims: number,
    transactional: boolean,
    count: number,
    ask: Ask = claimAsk,
    setup: Setup = {},
  ) {
    let state = 1;
    const next = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
    const runs: Run[] = [];
    for (let at = 0; at < count; at++) {
      runs.push(await play(row(), claims, transactional, choices => next(choices.length), ask, setup));
    }
    return runs;
  }

  /** Each problem once, however many schedules met it: a failing walk would print one line per schedule. */
  const problemsOf = (runs: Run[]): string[] => [...new Set(runs.flatMap(run => run.problems))];

  const summary = (runs: Run[]): string[] => [
    ...new Set(runs.flatMap(run => run.problems.concat(run.followUps === 1 ? [] : [`follow-up ran ${run.followUps}`]))),
  ];

  // The takeover is one event: the claim whose write took the row from the lapsed holder follows it up, whatever
  // became of that claim afterwards. A later claim of the same session reads this node as the previous holder.
  it.each([
    ['the handler a running gateway registers', true],
    ['a detached handler', false],
  ])(
    'follows up a takeover whose claim a later claim superseded after its write, with %s',
    async (_label, transactional) => {
      // A reads the previous holder, B renews and misses, A's write lands, B's reply takes A's generation, A's reply.
      const script = transactional
        ? [
            'lock:exec',
            'lock:reply',
            'select:exec',
            'renew:exec',
            'select:reply',
            'renew:reply',
            'write:exec',
            'write:reply',
          ]
        : ['select:exec', 'renew:exec', 'select:reply', 'renew:reply', 'write:exec', 'select:exec', 'write:reply'];
      const run = await play(lapsedPeer(), 2, transactional, (choices, step) => {
        const [label, stage] = (script[step] ?? ':').split(':');
        return Math.max(
          0,
          choices.findIndex(gate => gate.label === label && gate.stage === stage),
        );
      });

      expect(run.problems).toEqual([]);
      expect(run.followUps).toBe(1);
      // The superseded claim set nothing and called nothing; the later claim holds the row.
      expect(run.onClaimed).toEqual(['B']);
    },
  );

  it('follows up the takeover exactly once in every schedule of two claims with the handler a running gateway registers', async () => {
    const runs = await walk(lapsedPeer, 2, true);

    expect(runs.length).toBeGreaterThan(20);
    expect(summary(runs)).toEqual([]);
  });

  // Two claims that both read the lapsed holder before either wrote can each follow it up when the handler is detached;
  // the handler is idempotent. No schedule follows it up zero times.
  it('follows up the takeover at least once in every schedule of two claims with a detached handler', async () => {
    const runs = await walk(lapsedPeer, 2, false);

    expect(runs.length).toBeGreaterThan(80);
    expect(problemsOf(runs)).toEqual([]);
    for (const run of runs) expect([1, 2]).toContain(run.followUps);
  });

  it.each([true, false])(
    'follows up the takeover once in sampled schedules of three claims, transactional %s',
    async transactional => {
      const runs = await sample(lapsedPeer, 3, transactional, 150);

      expect(problemsOf(runs)).toEqual([]);
      for (const run of runs) expect(run.followUps).toBeGreaterThanOrEqual(1);
      if (transactional) expect(summary(runs)).toEqual([]);
    },
  );

  it('follows up nothing when the row was free or held by the node', async () => {
    for (const row of [freeRow, heldByNode]) {
      const runs = await walk(row, 2, true);

      expect(problemsOf(runs)).toEqual([]);
      expect(runs.map(run => run.followUps)).toEqual(runs.map(() => 0));
    }
  });

  it('follows up nothing and claims nothing while a live peer holds the row', async () => {
    const runs = await walk(livePeer, 2, true);

    expect(problemsOf(runs)).toEqual([]);
    expect(runs.map(run => run.followUps)).toEqual(runs.map(() => 0));
    expect(runs.map(run => run.onClaimed)).toEqual(runs.map(() => []));
  });

  // A claim that a newer generation superseded answers for the claim that took it, and once that has settled for whether
  // a claim of this node stands. Nothing but a peer's live lease makes a claim answer false, however many overlap: the
  // answers of every schedule below are the ones a node alone gives, and so are the ones a start and a delete read.
  describe('claims of one session that no other node contests', () => {
    // What a start and a delete ask of the node: a claim, and when it misses without a peer holding the row, one more.
    const startOrDelete = (
      Object.create(SessionService.prototype) as {
        claimUnlessHeldElsewhere: (
          id: string,
          ownership: SessionOwnershipService,
          onClaimed: (owns: () => boolean) => void,
        ) => Promise<boolean>;
      }
    ).claimUnlessHeldElsewhere;
    const askLikeStartOrDelete: Ask = (node, id, onClaimed) =>
      startOrDelete.call(Object.create(null), id, node, onClaimed);
    const forms = [
      ['the handler a running gateway registers', true],
      ['a detached handler', false],
    ] as const;

    // A begins and takes generation 1. B and C begin while it is in flight and renew, both reading generation 1. B's
    // reply comes first and misses, so B takes generation 2 and A is superseded. C's reply then finds the generation
    // replaced by a claim that began before it: C did not take it, and answers for B, as A does.
    it.each([
      [
        'the handler a running gateway registers',
        true,
        [
          'renew:exec',
          'renew:exec',
          'lock:exec',
          'renew:reply',
          'renew:reply',
          'lock:reply',
          'select:exec',
          'select:reply',
          'lock:exec',
          'lock:reply',
          'select:exec',
          'select:reply',
          'write:exec',
          'write:reply',
        ],
      ],
      [
        'a detached handler',
        false,
        [
          'select:exec',
          'renew:exec',
          'renew:exec',
          'renew:reply',
          'select:reply',
          'select:exec',
          'select:reply',
          'write:exec',
          'write:reply',
          'renew:reply',
        ],
      ],
    ])(
      'answers three claims true when the last to begin is superseded by the one before it, with %s',
      async (_label, transactional, script) => {
        const run = await play(freeRow(), 3, transactional, (choices, step) => {
          const [label, stage] = (script[step] ?? ':').split(':');
          return Math.max(
            0,
            choices.findIndex(gate => gate.label === label && gate.stage === stage),
          );
        });

        expect(run.problems).toEqual([]);
        expect(run.answers).toEqual([true, true, true]);
        expect(run.onClaimed).toEqual(['B']);
      },
    );

    it.each(forms)(
      'answers every claim true in every schedule of two claims on a row the node holds, with %s',
      async (_label, transactional) => {
        const runs = await walk(heldByNode, 2, transactional);

        expect(runs.length).toBeGreaterThan(10);
        expect(problemsOf(runs)).toEqual([]);
      },
    );

    it.each(forms)(
      'answers every claim true in every schedule of three claims on a free row, with %s',
      async (_label, transactional) => {
        const runs = await walk(freeRow, 3, transactional);

        expect(runs.length).toBeGreaterThan(1000);
        expect(problemsOf(runs)).toEqual([]);
      },
      300_000,
    );

    it.each(forms)(
      'answers every claim true in every schedule of three claims on a row the node holds, with %s',
      async (_label, transactional) => {
        const runs = await walk(heldByNode, 3, transactional);

        expect(runs.length).toBeGreaterThan(300);
        expect(problemsOf(runs)).toEqual([]);
      },
      300_000,
    );

    it.each(forms)(
      'answers every claim true in every schedule of three claims on the row of a lapsed holder, with %s',
      async (_label, transactional) => {
        const runs = await walk(lapsedPeer, 3, transactional);

        expect(runs.length).toBeGreaterThan(1000);
        expect(problemsOf(runs)).toEqual([]);
      },
      300_000,
    );

    it.each(forms)(
      'answers every claim true in sampled schedules of four claims on a free row, with %s',
      async (_label, transactional) => {
        const runs = await sample(freeRow, 4, transactional, 200);

        expect(problemsOf(runs)).toEqual([]);
      },
      120_000,
    );

    it.each([3, 4])(
      'answers %i overlapping starts or deletes true in sampled schedules on a free row',
      async calls => {
        const runs = await sample(freeRow, calls, true, 200, askLikeStartOrDelete);

        expect(problemsOf(runs)).toEqual([]);
      },
      120_000,
    );

    // A release ends the claim in flight and clears the row. A claim that begins once the release ended takes the next
    // generation before the interrupted one looks again, so the interrupted claim answers for it: true, as the claim that
    // holds the row does, where it would otherwise answer false with no other node in sight. The release goes first, and
    // nothing else while it is under way, so that the later claim finds the interrupted one waiting. A claim that holds
    // a transaction keeps the database from the release on SQLite, so this is the detached handler's.
    it('answers a claim a release interrupted with the answer of the claim that began after it', async () => {
      const releaseFirst = (choices: Gate[], _step: number, state: { releasing: number }): number => {
        const release = choices.findIndex(gate => gate.label === 'release');
        return release >= 0 ? release : state.releasing > 0 ? -1 : 0;
      };

      const run = await play(freeRow(), 2, false, releaseFirst, claimAsk, {
        releases: 1,
        releaseAt: 1,
        lastClaimWhenReleasing: 0,
      });

      expect(run.problems).toEqual([]);
      expect(run.answers).toEqual([true, true]);
    });

    // The other side: a peer that holds the row on a live lease refuses every claim, and the check a start and a delete
    // make confirms it, whatever the order of the statements.
    it('answers every claim false in sampled schedules of three claims while a live peer holds the row', async () => {
      const runs = await sample(livePeer, 3, true, 200);

      expect(problemsOf(runs)).toEqual([]);
      expect(runs.map(run => run.onClaimed)).toEqual(runs.map(() => []));
    }, 120_000);

    it('answers every start or delete false in sampled schedules of three while a live peer holds the row', async () => {
      const runs = await sample(livePeer, 3, true, 200, askLikeStartOrDelete);

      expect(problemsOf(runs)).toEqual([]);
    }, 120_000);
  });

  // A release clears the row this node holds, and a claim of this node writes that same owner: were the claim's write to
  // land first, the release would clear the row of a claim the node holds. The claims below begin while the release is
  // writing, so they wait for it, and in every schedule they end holding the row they wrote.
  describe('claims that begin while a release of the session by this node is writing', () => {
    const forms = [
      ['the handler a running gateway registers', true],
      ['a detached handler', false],
    ] as const;
    const rows = [
      ['a free row', freeRow, {}],
      ['a row this node holds, in memory and in the database', freeRow, { holds: true }],
      ['a row only the database says this node holds', heldByNode, {}],
    ] as const;
    const cases = forms.flatMap(([formLabel, transactional]) =>
      rows.map(([rowLabel, row, setup]) => [`${rowLabel}, with ${formLabel}`, row, setup, transactional] as const),
    );

    it.each(cases)(
      'ends holding the row in every schedule of one release and one claim on %s',
      async (_label, row, setup, transactional) => {
        const runs = await walk(row, 1, transactional, { ...setup, releases: 1 });

        expect(problemsOf(runs)).toEqual([]);
      },
      120_000,
    );

    it.each(cases)(
      'ends holding the row in every schedule of one release and two claims on %s',
      async (_label, row, setup, transactional) => {
        const runs = await walk(row, 2, transactional, { ...setup, releases: 1 });

        expect(problemsOf(runs)).toEqual([]);
      },
      300_000,
    );

    // Two stops of the session in a row each release: a claim waits for both, not only the last to begin.
    it.each(cases)(
      'ends holding the row in every schedule of two releases and one claim on %s',
      async (_label, row, setup, transactional) => {
        const runs = await walk(row, 1, transactional, { ...setup, releases: 2 });

        expect(problemsOf(runs)).toEqual([]);
      },
      300_000,
    );

    // Two stops of one session in a row each release. A claim that begins once the first has ended, while the second is
    // still writing, waits for the second: the entry of the first must not stand in for it, or the claim writes the row
    // and the second release clears it.
    it.each(forms)(
      'ends holding the row when a claim begins between two overlapping releases, with %s',
      async (_label, transactional) => {
        const firstReleaseAlone = (choices: Gate[], _step: number, state: { releasing: number }): number => {
          if (state.releasing === 2) {
            const reply = choices.findIndex(gate => gate.label === 'release' && gate.stage === 'reply');
            return reply >= 0 ? reply : 0;
          }
          // What is held besides the second release goes first, so that a claim that did not wait would write before it.
          const other = choices.findIndex(gate => gate.label !== 'release');
          return other >= 0 ? other : 0;
        };

        const run = await play(freeRow(), 1, transactional, firstReleaseAlone, claimAsk, {
          holds: true,
          releases: 2,
          lastClaimWhenReleasing: 1,
        });

        expect(run.problems).toEqual([]);
        expect(run.answers).toEqual([true]);
      },
      120_000,
    );

    // What a node does on its way down releases every claim it holds in one statement.
    it.each(forms)(
      'ends holding the row in every schedule of a shutdown release and one claim, with %s',
      async (_label, transactional) => {
        const runs = await walk(freeRow, 1, transactional, { holds: true, releases: 1, shutdown: true });

        expect(problemsOf(runs)).toEqual([]);
      },
      120_000,
    );

    // The release takes the lapsed holder's row over, and follows that up; the claim then finds a row nobody holds.
    it.each(forms)(
      'follows up the takeover of a lapsed holder once when a release and a claim overlap, with %s',
      async (_label, transactional) => {
        const runs = await walk(lapsedPeer, 1, transactional, { releases: 1 });

        expect(problemsOf(runs)).toEqual([]);
        expect(runs.map(run => run.followUps)).toEqual(runs.map(() => 1));
      },
      120_000,
    );

    it('leaves the row of a live peer to it, and refuses every claim', async () => {
      const runs = await walk(livePeer, 2, true, { releases: 1 });

      expect(problemsOf(runs)).toEqual([]);
      expect(runs.map(run => run.onClaimed)).toEqual(runs.map(() => []));
    }, 300_000);
  });
});
