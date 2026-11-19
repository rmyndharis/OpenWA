import { DataSource, Repository } from 'typeorm';
import { LidMappingStoreService } from './lid-mapping-store.service';
import { LidMapping } from './lid-mapping.entity';
import { Session } from '../../modules/session/entities/session.entity';
import { ChatScopeService } from '../../modules/auth/chat-scope.service';

/**
 * Every order of the writes of one lid, in a small scope, over the real store on SQLite. The table statements of the
 * calls are parked and settled by the script, in the order of the calls (the store runs the statements of one lid in
 * that order), each succeeding or failing; between them the mirror entry of the lid is evicted or the mapping
 * reloaded. After every step the readers are compared with a reference that knows only the order
 * of the calls and of their landings: while a phone this process holds is not stored, or a display lookup's revocation
 * is not stored, the lid answers none, and otherwise at most the phone the table holds.
 */
type Outcome = 'ok' | 'fail';
interface CallSpec {
  name: string;
  kind: 'report' | 'negative' | 'lookup';
  phone: string | null;
  session: string;
}
type Step = { step: 'begin' } | { step: 'settle'; outcome: Outcome } | { step: 'evict' | 'reload' };

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STORED = '628111';
const FIRST = '628222';
const SECOND = '628333';
const PHONES = [STORED, FIRST, SECOND];
const LID = '333';
const CALLS: Record<string, CallSpec> = {
  reportStored: { name: 'report of the stored phone', kind: 'report', phone: STORED, session: OWNER },
  reportFirst: { name: 'report of the first phone', kind: 'report', phone: FIRST, session: OWNER },
  reportSecond: { name: 'report of the second phone', kind: 'report', phone: SECOND, session: OWNER },
  negative: { name: 'negative of the owner', kind: 'negative', phone: null, session: OWNER },
  foreignNegative: { name: 'negative of another session', kind: 'negative', phone: null, session: OTHER },
  lookupStored: { name: 'lookup of the stored phone', kind: 'lookup', phone: STORED, session: OTHER },
  lookupFirst: { name: 'lookup of the first phone', kind: 'lookup', phone: FIRST, session: OTHER },
  lookupSecond: { name: 'lookup of the second phone', kind: 'lookup', phone: SECOND, session: OTHER },
};

/** What the process holds for the lid, from the order of the calls and of their landings alone. */
class Reference {
  /** The phone of the mirror entry: undefined when there is none. */
  held: string | null | undefined = STORED;
  report?: { index: number; phone: string; state: 'pending' | 'stored' | 'failed' | 'ended' };
  revocation?: { index: number; state: 'pending' | 'failed' };
  private readonly begun: boolean[];
  private readonly open: boolean[];

  constructor(private readonly calls: CallSpec[]) {
    this.begun = calls.map(() => false);
    this.open = calls.map(() => false);
  }

  /** Whether the call, a lookup, contradicts the phone held. */
  begin(index: number): boolean {
    const call = this.calls[index];
    this.begun[index] = true;
    this.open[index] = true;
    if (call.kind === 'report') {
      this.report = { index, phone: call.phone as string, state: 'pending' };
      this.revocation = undefined;
      this.held = call.phone;
    } else if (call.kind === 'lookup' && typeof this.held === 'string' && this.held !== call.phone) {
      this.revocation = { index, state: 'pending' };
      return true;
    }
    return false;
  }

  land(index: number, outcome: Outcome, affected: number): void {
    const call = this.calls[index];
    this.open[index] = false;
    const stored = outcome === 'ok';
    if (call.kind === 'report' && this.report?.index === index) this.report.state = stored ? 'stored' : 'failed';
    else if (call.kind === 'lookup' && this.revocation?.index === index) {
      if (stored) this.revocation = undefined;
      else this.revocation.state = 'failed';
    } else if (call.kind === 'negative' && stored && affected > 0) {
      // A negative that cleared the row ends what the writes before it were held against, unless a report began after it.
      if (!this.calls.some((later, i) => i > index && this.begun[i] && later.kind === 'report')) {
        if (this.report && this.report.state !== 'stored') this.report.state = 'ended';
        this.revocation = undefined;
      }
      const latest = this.calls.map((c, i) => (this.begun[i] && c.kind !== 'lookup' ? c : undefined)).filter(Boolean);
      if (latest[latest.length - 1]?.kind !== 'report') this.held = undefined;
    }
  }

  pending(): boolean {
    return this.open.some(Boolean);
  }

  reload(row: string | null | undefined): void {
    if (this.report?.state === 'failed') this.report.state = 'ended';
    if (this.revocation?.state === 'failed') this.revocation = undefined;
    this.held = this.pending() ? undefined : row;
  }

  /** Why the lid must answer none, or '' when it may answer the row. */
  refusal(row: { phone: string | null; isReported: boolean } | null): string {
    if (!row || !row.isReported || row.phone === null) return 'the row names no phone';
    if (this.revocation) return `a display lookup's revocation is ${this.revocation.state}`;
    const unwritten = this.report && (this.report.state === 'pending' || this.report.state === 'failed');
    return unwritten && row.phone !== this.report?.phone ? `a report is ${this.report?.state}` : '';
  }
}

describe('LidMappingStoreService: every order of the writes of one lid', () => {
  const savedCap = process.env.LID_MAPPING_CACHE_MAX;
  let ds: DataSource;
  let slow: Repository<LidMapping>;
  let gated = false;
  let parked: Array<{
    method: string;
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  let inflight = 0;

  beforeAll(async () => {
    process.env.LID_MAPPING_CACHE_MAX = '3'; // three lids push the one under test out of the mirror
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LidMapping, Session],
      synchronize: true,
    }).initialize();
    await ds.getRepository(Session).insert([
      { id: OWNER, name: 'owner', phone: '6290000001' },
      { id: OTHER, name: 'other', phone: '6290000002' },
    ]);
    // SQLite hands every caller the one query runner: count the statements in flight.
    const runner = ds.createQueryRunner();
    const query = runner.query.bind(runner) as (...args: unknown[]) => Promise<unknown>;
    (runner as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      inflight++;
      try {
        return await query(...args);
      } finally {
        inflight--;
      }
    };
    slow = new Repository(LidMapping, ds.manager);
    for (const method of ['update', 'upsert', 'query'] as const) {
      const real = (slow[method] as (...args: unknown[]) => Promise<unknown>).bind(slow);
      jest
        .spyOn(slow, method)
        .mockImplementation(((...args: unknown[]) =>
          gated
            ? new Promise((resolve, reject) => parked.push({ method, run: () => real(...args), resolve, reject }))
            : real(...args)) as never);
    }
  });

  afterAll(async () => {
    await ds.destroy();
    if (savedCap === undefined) delete process.env.LID_MAPPING_CACHE_MAX;
    else process.env.LID_MAPPING_CACHE_MAX = savedCap;
  });

  /** Until every statement in flight has ended and every call has reached its next parked statement. */
  const settleAll = async (): Promise<void> => {
    const deadline = Date.now() + 30_000;
    for (let stable = 0, last = ''; stable < 2;) {
      await new Promise<void>(resolve => setImmediate(resolve));
      const now = `${parked.length}:${inflight}`;
      stable = inflight === 0 && now === last ? stable + 1 : 0;
      last = now;
      if (Date.now() > deadline) throw new Error('the store did not reach a resting state');
    }
  };

  type Internals = {
    unsettledWrites: Map<string, { revoking?: object }>;
    lidToPhone: Map<string, string | null>;
    unreported: Set<string>;
    index: (lid: string, phone: string | null, sessionId: string | null, isReported?: boolean) => void;
  };

  const describeRun = (calls: CallSpec[], steps: Step[]): string => {
    let begun = 0;
    let settled = 0;
    return steps
      .map(step =>
        step.step === 'begin'
          ? `begin ${calls[begun++].name}`
          : step.step === 'settle'
            ? `${step.outcome === 'ok' ? 'land' : 'fail'} ${calls[settled++].name}`
            : step.step,
      )
      .join(', ');
  };

  /** Runs one schedule and returns what went wrong, if anything. */
  const run = async (calls: CallSpec[], steps: Step[]): Promise<string[]> => {
    const problems: string[] = [];
    const repo = ds.getRepository(LidMapping);
    gated = false;
    parked = [];
    await repo.clear();
    await repo.insert({ lid: LID, phone: STORED, sessionId: OWNER, isReported: true });
    const store = new LidMappingStoreService(slow);
    Object.assign((store as unknown as { logger: object }).logger, { warn: () => undefined, log: () => undefined });
    await store.onModuleInit();
    gated = true;
    const inner = store as unknown as Internals;
    const reference = new Reference(calls);
    const scope = new ChatScopeService(store);
    const calling: Array<Promise<unknown>> = [];
    const own = `${LID}@lid`;
    let begun = 0;
    let settled = 0;
    let fillers = 0;
    let failed = false;

    // The row changes only when a parked statement lands, so it is read again after a landing.
    let row = await repo.findOneBy({ lid: LID });
    const check = async (after: string, fence: boolean): Promise<void> => {
      const refusal = reference.refusal(row);
      const answer = await store.findPhoneForLid(own);
      if (answer !== null && (refusal !== '' || answer !== row?.phone))
        problems.push(`after ${after}: the lid answers ${answer} while ${refusal || 'the row names another phone'}`);
      const mirror = inner.unreported.has(LID) ? null : (inner.lidToPhone.get(LID) ?? null);
      if (mirror !== null && mirror !== reference.held)
        problems.push(`after ${after}: the mirror answers ${mirror}, not ${String(reference.held)}`);
      if (!fence) return;
      for (const phone of PHONES) {
        const admitted = await scope.allows({ allowedChats: [`${phone}@c.us`] }, own);
        if (admitted && (refusal !== '' || phone !== row?.phone))
          problems.push(
            `after ${after}: a key limited to ${phone} reaches the lid while ${refusal || 'the row names another phone'}`,
          );
      }
    };

    for (const [at, step] of steps.entries()) {
      let after = step.step as string;
      if (step.step === 'begin') {
        const index = begun++;
        const call = calls[index];
        const before = inner.unsettledWrites.get(LID)?.revoking;
        const contradicts = reference.begin(index);
        calling.push(
          call.kind === 'lookup'
            ? store.rememberIfUnknown(LID, call.phone as string, call.session)
            : store.remember(LID, call.phone, call.session),
        );
        if (call.kind === 'lookup' && (inner.unsettledWrites.get(LID)?.revoking !== before) !== contradicts)
          problems.push(
            `the ${call.name} ${contradicts ? 'did not revoke' : 'revoked'} where the reference holds ${String(reference.held)}`,
          );
        after = `begin ${call.name}`;
        await settleAll();
      } else if (step.step === 'settle') {
        const index = settled++;
        const next = parked.shift();
        if (!next) throw new Error('no statement is parked to settle');
        let affected = 0;
        if (step.outcome === 'fail') {
          failed = true;
          next.reject(new Error('connection lost'));
        } else {
          const result = (await next.run()) as { affected?: number };
          affected = next.method === 'update' ? (result?.affected ?? 0) : 0;
          next.resolve(result);
        }
        reference.land(index, step.outcome, affected);
        after = `${step.outcome === 'ok' ? 'landing' : 'failure'} of the ${calls[index].name}`;
        await settleAll();
        row = await repo.findOneBy({ lid: LID });
      } else if (step.step === 'evict') {
        for (let i = 0; i < 3; i++) inner.index(`${LID}0${fillers++}`, `62877${i}`, null);
        reference.held = undefined;
      } else {
        gated = false;
        await store.reload();
        gated = true;
        reference.reload(row === null ? undefined : row.phone);
      }
      await check(after, at === steps.length - 1);
    }
    await Promise.allSettled(calling);
    gated = false;
    if (!failed) {
      // Nothing failed and everything has landed: the readers answer exactly what the table holds.
      const settledRow = await repo.findOneBy({ lid: LID });
      const want = settledRow?.isReported ? settledRow.phone : null;
      const answer = await store.findPhoneForLid(own);
      if (answer !== want)
        problems.push(`settled without a failure, the lid answers ${String(answer)}, not ${String(want)}`);
    }
    store.onModuleDestroy();
    return problems;
  };

  /** Every ordering of `count` begins and landings, the k-th landing being that of the k-th call. */
  const orders = (count: number): Array<Array<'begin' | 'settle'>> => {
    const out: Array<Array<'begin' | 'settle'>> = [];
    const go = (seq: Array<'begin' | 'settle'>, begun: number, settled: number): void => {
      if (begun === count && settled === count) out.push(seq);
      if (begun < count) go([...seq, 'begin'], begun + 1, settled);
      if (settled < begun) go([...seq, 'settle'], begun, settled + 1);
    };
    go([], 0, 0);
    return out;
  };

  /** Every list of calls, with every ordering of their begins and landings, every landing succeeding or failing. */
  const schedules = function* (
    lists: CallSpec[][],
    between: Array<'evict' | 'reload'>,
    maxFailures: number,
  ): Generator<{ calls: CallSpec[]; steps: Step[] }> {
    for (const calls of lists) {
      for (const order of orders(calls.length)) {
        for (let mask = 0; mask < 1 << calls.length; mask++) {
          if (mask.toString(2).split('1').length - 1 > maxFailures) continue;
          let landing = 0;
          const steps: Step[] = order.map(kind =>
            kind === 'begin' ? { step: 'begin' } : { step: 'settle', outcome: mask & (1 << landing++) ? 'fail' : 'ok' },
          );
          yield { calls, steps };
          for (let slot = 0; slot < steps.length; slot++)
            for (const event of between)
              yield { calls, steps: [...steps.slice(0, slot + 1), { step: event }, ...steps.slice(slot + 1)] };
        }
      }
    }
  };

  /** The lists of `count` calls drawn from these names. */
  const lists = (names: string[], count: number): CallSpec[][] => {
    let out: CallSpec[][] = [[]];
    for (let i = 0; i < count; i++) out = out.flatMap(list => names.map(name => [...list, CALLS[name]]));
    return out;
  };

  const explore = async (
    from: CallSpec[][],
    between: Array<'evict' | 'reload'>,
    maxFailures: number,
  ): Promise<{ explored: number; problems: string[] }> => {
    const problems = new Map<string, string>();
    let explored = 0;
    for (const { calls, steps } of schedules(from, between, maxFailures)) {
      explored++;
      const found = await run(calls, steps);
      if (found.length && problems.size < 5) problems.set(found[0], describeRun(calls, steps));
    }
    return { explored, problems: [...problems].map(([problem, schedule]) => `${problem} (${schedule})`) };
  };

  it('answers the lid no phone it no longer has, in every order of two calls', async () => {
    const names = ['reportStored', 'reportFirst', 'negative', 'lookupStored', 'lookupFirst'];
    const found = await explore(lists(names, 2), ['evict', 'reload'], 1);
    expect(found.explored).toBeGreaterThan(1000);
    expect(found.problems).toEqual([]);
  }, 120_000);

  it('answers the lid no phone it no longer has, when a negative lands before the reports begun after it', async () => {
    const calls = [CALLS.negative, CALLS.reportFirst, CALLS.reportSecond, CALLS.negative];
    const found = await explore([calls], ['evict'], 1);
    expect(found.explored).toBeGreaterThan(500);
    expect(found.problems).toEqual([]);
  }, 120_000);
});
