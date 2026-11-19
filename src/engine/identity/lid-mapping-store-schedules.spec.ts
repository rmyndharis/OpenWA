import { DataSource, Repository } from 'typeorm';
import { LidMappingStoreService } from './lid-mapping-store.service';
import { LidMapping } from './lid-mapping.entity';
import { Session } from '../../modules/session/entities/session.entity';
import { ChatScopeService } from '../../modules/auth/chat-scope.service';

/**
 * Every order of the writes of one lid in a small scope, over the real store, each landing succeeding or failing. The
 * table statements of the calls are parked and settled by the script in the order of the calls (the store runs the
 * statements of one lid in that order). Between them the environment acts: the mirror entry of the lid is evicted or
 * warmed back, the mapping reloads, in one step or with its table read out while the calls go on, another node writes
 * the row, and a failing sync of other lids fills the failed-write marks past their bound.
 *
 * After every step the readers (the phone of the lid and the chat fence by phone, and in the full scopes the batch and
 * reverse readers and the fence in both directions) are compared with a reference that knows only the order of the
 * calls and of their landings, never the store's bookkeeping: while a phone this process holds for the lid is not
 * stored, or the revocation of a display lookup is not stored, the lid answers none, and otherwise at most the phone of
 * the row. The other lids of the script have a truth of their own: one whose write failed answers none until it is
 * reported again or the mapping reloads, one that no call touches answers its row throughout.
 */
type Outcome = 'ok' | 'fail' | 'failAfter';
interface CallSpec {
  name: string;
  kind: 'report' | 'negative' | 'lookup';
  phone: string | null;
  session: string;
}
type Environment =
  | 'evict'
  | 'reload'
  | 'warm'
  | 'peer'
  | 'reloadBegin'
  | 'reloadEnd'
  | 'failReports'
  | 'failLookups'
  | 'recover'
  | 'down'
  | 'up';
type Step = { step: 'begin' } | { step: 'settle'; outcome: Outcome } | { step: Environment };
type Init = 'reported' | 'display' | 'none' | 'negative';
interface Scope {
  inits: Init[];
  lists: CallSpec[][];
  /** Each sequence of events is inserted, in order, at every choice of places among the steps. */
  events: Environment[][];
  outcomes: Outcome[];
  maxFailures: number;
  /** Also run the batch and reverse readers and the chat fence in both directions. */
  full: boolean;
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STORED = '628111';
const FIRST = '628222';
const SECOND = '628333';
const PEER = '628444';
const PHONES = [STORED, FIRST, SECOND, PEER];
const LID = '333';
const CALLS: Record<string, CallSpec> = {
  reportStored: { name: 'RS', kind: 'report', phone: STORED, session: OWNER },
  reportFirst: { name: 'RA', kind: 'report', phone: FIRST, session: OWNER },
  reportSecond: { name: 'RB', kind: 'report', phone: SECOND, session: OWNER },
  reportOther: { name: 'RS2', kind: 'report', phone: STORED, session: OTHER },
  negative: { name: 'N', kind: 'negative', phone: null, session: OWNER },
  foreignNegative: { name: 'X', kind: 'negative', phone: null, session: OTHER },
  lookupStored: { name: 'KS', kind: 'lookup', phone: STORED, session: OTHER },
  lookupFirst: { name: 'KA', kind: 'lookup', phone: FIRST, session: OTHER },
  lookupSecond: { name: 'KB', kind: 'lookup', phone: SECOND, session: OTHER },
};

/** Lids that no call of the script writes, with the row each holds: the first three fail a report, the rest a lookup. */
const REPORT_FILLERS = [
  { lid: 'f1', row: '628501', engine: '628601' },
  { lid: 'f2', row: '628502', engine: '628602' },
  { lid: 'f3', row: '628503', engine: '628603' },
];
const LOOKUP_FILLERS = [
  { lid: 'g1', row: '628701', engine: '628701' },
  { lid: 'g2', row: '628702', engine: '628702' },
  { lid: 'g3', row: '628703', engine: '628703' },
];
const UNTOUCHED = { lid: 'u1', row: '628801' };
const FILLER_LIDS = new Set([...REPORT_FILLERS, ...LOOKUP_FILLERS].map(filler => filler.lid));

/** What the process holds for the lid, from the order of the calls and of their landings alone. */
class Reference {
  /** The phone of the mirror entry: undefined when there is none. */
  held: string | null | undefined;
  report?: { index: number; phone: string; state: 'pending' | 'stored' | 'failed' | 'ended' };
  /** The lookups begun after the latest report: those that contradicted the mirror and are being written, or failed. */
  lookups: Array<{ index: number; state: 'pending' | 'failed' }> = [];
  private readonly begun: boolean[];
  private readonly landed: boolean[];
  private reading = false;
  private racedAtBegin = false;
  private racedDuring = false;
  private predatingReport?: object;
  private predatingLookups: object[] = [];

  constructor(
    private readonly calls: CallSpec[],
    init: Init,
  ) {
    this.begun = calls.map(() => false);
    this.landed = calls.map(() => false);
    this.held = init === 'none' ? undefined : init === 'negative' ? null : STORED;
  }

  /** Whether the call, a lookup, contradicts the phone held. */
  begin(index: number): boolean {
    const call = this.calls[index];
    this.begun[index] = true;
    if (this.reading) this.racedDuring = true;
    if (call.kind === 'report') {
      this.report = { index, phone: call.phone as string, state: 'pending' };
      this.lookups = [];
      this.held = call.phone;
    } else if (call.kind === 'lookup' && typeof this.held === 'string' && this.held !== call.phone) {
      this.lookups.push({ index, state: 'pending' });
      return true;
    }
    return false;
  }

  private reportBegunAfter(index: number): boolean {
    return this.calls.some((later, i) => i > index && this.begun[i] && later.kind === 'report');
  }

  land(index: number, outcome: Outcome, affected: number): void {
    const call = this.calls[index];
    this.landed[index] = true;
    const stored = outcome === 'ok';
    if (call.kind === 'report') {
      if (this.report?.index === index) this.report.state = stored ? 'stored' : 'failed';
    } else if (call.kind === 'lookup') {
      const lookup = this.lookups.find(l => l.index === index);
      if (stored) this.lookups = this.lookups.filter(l => l !== lookup);
      // A lookup that failed may have revoked a row the mirror did not hold: it is marked, whatever it named.
      else if (lookup) lookup.state = 'failed';
      else if (!this.reportBegunAfter(index)) this.lookups.push({ index, state: 'failed' });
    } else if (stored && affected > 0) {
      // A negative that cleared the row ends what the writes before it were held against, unless a report began later.
      if (!this.reportBegunAfter(index)) {
        if (this.report && this.report.state !== 'stored') this.report.state = 'ended';
        this.lookups = [];
      }
      const latest = this.calls.map((c, i) => (this.begun[i] && c.kind !== 'lookup' ? c : undefined)).filter(Boolean);
      if (latest[latest.length - 1]?.kind !== 'report') this.held = undefined;
    }
  }

  pending(): boolean {
    return this.calls.some((_, i) => this.begun[i] && !this.landed[i]);
  }

  evict(): void {
    this.held = undefined;
  }

  /** A reload that reads the table at once. A lid with a write under way is not taken from it, and keeps its marks. */
  reload(row: string | null | undefined): void {
    if (!this.pending()) {
      if (this.report?.state === 'failed') this.report.state = 'ended';
      this.lookups = this.lookups.filter(l => l.state !== 'failed');
    }
    this.held = this.pending() ? undefined : row;
  }

  reloadBegin(): void {
    this.reading = true;
    this.racedDuring = false;
    this.racedAtBegin = this.pending();
    // The marks that predate the read end with it, against the table it replaced, unless a write of the lid is under way.
    this.predatingReport = this.report?.state === 'failed' ? this.report : undefined;
    this.predatingLookups = this.lookups.filter(l => l.state === 'failed');
  }

  reloadEnd(row: string | null | undefined): void {
    this.reading = false;
    const raced = this.racedAtBegin || this.racedDuring;
    if (!raced) {
      if (this.report && this.report === this.predatingReport && this.report.state === 'failed')
        this.report.state = 'ended';
      this.lookups = this.lookups.filter(l => !this.predatingLookups.includes(l) || l.state !== 'failed');
    }
    this.held = raced ? undefined : row;
  }

  warm(row: string | null | undefined): void {
    if (this.held === undefined && !this.pending()) this.held = row;
  }

  /** The phone the lid must answer once its latest call, a report, has landed with nothing else under way. */
  mustAnswer(row: { phone: string | null; isReported: boolean } | null): string | undefined {
    const latest = this.calls.findLastIndex((call, i) => this.begun[i] && call.kind !== 'lookup');
    const settled = this.report?.state === 'stored' && this.report.index === latest;
    return settled &&
      !this.pending() &&
      this.lookups.length === 0 &&
      row?.isReported &&
      row.phone === this.report?.phone
      ? row.phone
      : undefined;
  }

  /** Why the lid must answer none, or '' when it may answer the row. */
  refusal(row: { phone: string | null; isReported: boolean } | null): string {
    if (!row || !row.isReported || row.phone === null) return 'the row names no phone';
    const lookup = this.lookups[0];
    if (lookup) return `a display lookup is ${lookup.state}`;
    const unwritten = this.report && (this.report.state === 'pending' || this.report.state === 'failed');
    return unwritten && row.phone !== this.report?.phone ? `a report is ${this.report?.state}` : '';
  }
}

describe('LidMappingStoreService: every order of the writes of one lid', () => {
  const savedCap = process.env.LID_MAPPING_CACHE_MAX;
  let ds: DataSource;
  let slow: Repository<LidMapping>;
  let gated = false;
  let failingFillers = false;
  /** The table cannot be read: every read of the store fails, and the readers answer from the mirror. */
  let down = false;
  const read: { release?: () => void } = {};
  const takeRead = (): (() => void) | undefined => {
    const release = read.release;
    read.release = undefined;
    return release;
  };
  let holdRead = false;
  let parked: Array<{
    method: string;
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  let inflight = 0;

  /** The lid a statement of the store is about: its first argument names it as a row or as a condition. */
  const lidOf = (args: unknown[]): string | undefined => {
    const first = args[0] as { lid?: unknown } | undefined;
    return typeof first?.lid === 'string' ? first.lid : undefined;
  };

  beforeAll(async () => {
    process.env.LID_MAPPING_CACHE_MAX = '3'; // three lids push the one under test out of the mirror, and bound its marks
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
    // A pool hands every statement a query runner of its own, SQLite the one: count the statements in flight.
    const wrapped = new WeakSet<object>();
    const createQueryRunner = ds.createQueryRunner.bind(ds);
    (ds as unknown as { createQueryRunner: unknown }).createQueryRunner = (mode?: 'master' | 'slave') => {
      const runner = createQueryRunner(mode);
      if (wrapped.has(runner)) return runner;
      wrapped.add(runner);
      const query = runner.query.bind(runner) as (...args: unknown[]) => Promise<unknown>;
      (runner as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        inflight++;
        try {
          return await query(...args);
        } finally {
          inflight--;
        }
      };
      return runner;
    };
    slow = new Repository(LidMapping, ds.manager);
    const find = (slow.find as (...args: unknown[]) => Promise<unknown>).bind(slow);
    const findOne = (slow.findOne as (...args: unknown[]) => Promise<unknown>).bind(slow);
    jest
      .spyOn(slow, 'findOne')
      .mockImplementation(((...args: unknown[]) =>
        down ? Promise.reject(new Error('the database is down')) : findOne(...args)) as never);
    jest.spyOn(slow, 'find').mockImplementation(((...args: unknown[]) => {
      if (down) return Promise.reject(new Error('the database is down'));
      if (!holdRead) return find(...args);
      holdRead = false;
      return new Promise((resolve, reject) => {
        read.release = () => void find(...args).then(resolve, reject);
      });
    }) as never);
    for (const method of ['update', 'upsert', 'query'] as const) {
      const real = (slow[method] as (...args: unknown[]) => Promise<unknown>).bind(slow);
      jest.spyOn(slow, method).mockImplementation(((...args: unknown[]) => {
        const lid = lidOf(args);
        // The other lids of the script write at once, and fail while the database is down.
        if (lid && FILLER_LIDS.has(lid) && gated)
          return failingFillers ? Promise.reject(new Error('connection lost')) : real(...args);
        return gated
          ? new Promise((resolve, reject) => parked.push({ method, run: () => real(...args), resolve, reject }))
          : real(...args);
      }) as never);
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
    pendingLookups: Set<string>;
    index: (lid: string, phone: string | null, sessionId: string | null, isReported?: boolean) => void;
    recordDropped: (lid: string) => void;
    markDropped: (lid: string) => boolean;
  };

  const describeRun = (init: Init, calls: CallSpec[], steps: Step[]): string => {
    let begun = 0;
    let settled = 0;
    const parts = steps.map(step =>
      step.step === 'begin'
        ? `begin ${calls[begun++].name}`
        : step.step === 'settle'
          ? `${step.outcome === 'ok' ? 'land' : step.outcome} ${calls[settled++].name}`
          : step.step,
    );
    return `row ${init}: ${parts.join(', ')}`;
  };

  const stats = { overRefused: 0 };

  /** Runs one schedule and returns what went wrong, if anything. */
  const run = async (init: Init, calls: CallSpec[], steps: Step[], full: boolean): Promise<string[]> => {
    const problems: string[] = [];
    const repo = ds.getRepository(LidMapping);
    gated = false;
    failingFillers = false;
    down = false;
    holdRead = false;
    read.release = undefined;
    parked = [];
    await repo.clear();
    // The newest row is the lid's, so a mirror of three loads it with the two rows before it.
    const rows: Array<Partial<LidMapping>> = [
      ...[...REPORT_FILLERS, ...LOOKUP_FILLERS].map(filler => ({ lid: filler.lid, phone: filler.row })),
      { lid: UNTOUCHED.lid, phone: UNTOUCHED.row },
    ];
    if (init !== 'none')
      rows.push({ lid: LID, phone: init === 'negative' ? null : STORED, isReported: init !== 'display' });
    for (const [at, row] of rows.entries())
      await repo.insert({ sessionId: OWNER, isReported: true, updatedAt: new Date(1_000_000 + at * 1000), ...row });
    const store = new LidMappingStoreService(slow);
    Object.assign((store as unknown as { logger: object }).logger, { warn: () => undefined, log: () => undefined });
    await store.onModuleInit();
    gated = true;
    const inner = store as unknown as Internals;
    const reference = new Reference(calls, init);
    const scope = new ChatScopeService(store);
    const calling: Array<Promise<unknown>> = [];
    const own = `${LID}@lid`;
    let begun = 0;
    let settled = 0;
    let evictions = 0;
    let failed = false;
    let peered = false;
    let reloading: Promise<void> | undefined;
    // What the script knows of the other lids: whether a write of theirs failed and whether a report has landed since.
    const fillers = new Map<
      string,
      { kind: 'report' | 'lookup'; row: string; engine: string; state: 'failed' | 'ended' | 'landed' }
    >();

    const unexpected = (after: string, what: string): void => {
      problems.push(`after ${after}: ${what}`);
    };

    const checkLid = async (after: string): Promise<void> => {
      const row = await repo.findOneBy({ lid: LID });
      // With the table unreadable the readers answer from the mirror, and its entry is judged as a row would be.
      const held = inner.unreported.has(LID) ? null : (inner.lidToPhone.get(LID) ?? null);
      const view = down ? (held === null ? null : { phone: held, isReported: true }) : row;
      const refusal = reference.refusal(view);
      const answer = await store.findPhoneForLid(own);
      if (answer !== null && (refusal !== '' || answer !== view?.phone))
        unexpected(after, `the lid answers ${answer} while ${refusal || 'the row names another phone'}`);
      else if (!down && answer === null && refusal === '') {
        stats.overRefused++;
        // At rest, the failed writes of other lids are no reason to refuse this one.
        if (!failed && !peered && !reference.pending())
          unexpected(after, 'the lid is refused though no write of it failed');
      }
      // A lid whose latest write landed answers it, whatever became of the other lids.
      const must = down ? undefined : reference.mustAnswer(row);
      if (must !== undefined && answer !== must)
        unexpected(after, `the lid whose report landed answers ${String(answer)}, not ${must}`);
      // The synchronous view of the mirror only ever holds what the calls left there.
      if (!inner.lidToPhone.has(LID)) reference.held = undefined;
      if (held !== null && held !== reference.held)
        unexpected(after, `the mirror answers ${held}, not ${String(reference.held)}`);
      const admits = async (key: string, chat: string): Promise<boolean> => scope.allows({ allowedChats: [key] }, chat);
      for (const phone of PHONES) {
        if (full || phone === STORED || phone === FIRST) {
          if ((await admits(`${phone}@c.us`, own)) && (refusal !== '' || phone !== view?.phone))
            unexpected(
              after,
              `a key limited to ${phone} reaches the lid while ${refusal || 'the row names another phone'}`,
            );
        }
        if (!full) continue;
        if ((await admits(own, `${phone}@c.us`)) && (refusal !== '' || phone !== view?.phone))
          unexpected(
            after,
            `a key limited to the lid reaches the chat of ${phone} while ${refusal || 'the row names another phone'}`,
          );
        const listed =
          (await store.findLidsForPhone(phone)).includes(LID) ||
          (await store.lidsForPhonesPersisted([phone]))[phone].includes(LID);
        if (listed && (refusal !== '' || phone !== view?.phone))
          unexpected(after, `the lid is listed for ${phone} while ${refusal || 'the row names another phone'}`);
      }
      if (full) {
        const batch = (await store.phonesForLidsPersisted([LID]))[LID];
        if (batch !== null && (refusal !== '' || batch !== view?.phone))
          unexpected(after, `the batch reader answers ${batch} while ${refusal || 'the row names another phone'}`);
      }
    };

    const checkFillers = async (after: string): Promise<void> => {
      for (const [lid, filler] of fillers) {
        const answer = await store.findPhoneForLid(`${lid}@lid`);
        if (filler.state === 'failed' && answer !== null && !(down && answer === filler.engine))
          unexpected(after, `a lid whose ${filler.kind} failed answers ${answer}, the table holds ${filler.row}`);
        if (!down && filler.state === 'landed' && answer !== filler.engine)
          unexpected(
            after,
            `a lid reported again after its write failed answers ${String(answer)}, not ${filler.engine}`,
          );
        if (
          full &&
          filler.state === 'failed' &&
          (await scope.allows({ allowedChats: [`${filler.row}@c.us`] }, `${lid}@lid`))
        )
          unexpected(after, `a key limited to ${filler.row} reaches the lid whose ${filler.kind} failed`);
      }
      const untouched = await store.findPhoneForLid(`${UNTOUCHED.lid}@lid`);
      if (!down && untouched !== UNTOUCHED.row)
        unexpected(after, `the lid no call wrote answers ${String(untouched)}, not ${UNTOUCHED.row}`);
    };

    for (const [at, step] of steps.entries()) {
      let after: string = step.step;
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
          unexpected(
            `begin ${call.name}`,
            `the lookup ${contradicts ? 'did not revoke' : 'revoked'} where the reference holds ${String(reference.held)}`,
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
          if (step.outcome === 'failAfter') {
            failed = true;
            next.reject(new Error('connection lost after the statement applied'));
          } else next.resolve(result);
        }
        reference.land(index, step.outcome, calls[index].kind === 'negative' ? affected : 0);
        after = `${step.outcome === 'ok' ? 'landing' : step.outcome} of ${calls[index].name}`;
        await settleAll();
      } else if (step.step === 'evict') {
        for (let i = 0; i < 3; i++) inner.index(`e${evictions++}`, `62877${i}`, null);
        reference.evict();
      } else if (step.step === 'down' || step.step === 'up') {
        down = step.step === 'down';
      } else if (step.step === 'reload') {
        gated = false;
        await store.reload();
        gated = true;
        if (!down) {
          const row = await repo.findOneBy({ lid: LID });
          reference.reload(row === null ? undefined : row.phone);
          for (const filler of fillers.values()) if (filler.state === 'failed') filler.state = 'ended';
        }
      } else if (step.step === 'reloadBegin') {
        holdRead = true;
        reloading = store.reload();
        holdRead = false;
        reference.reloadBegin();
        await settleAll();
      } else if (step.step === 'reloadEnd') {
        const release = takeRead();
        if (!release || !reloading) throw new Error('no reload read is out');
        release();
        await reloading;
        reloading = undefined;
        const row = await repo.findOneBy({ lid: LID });
        reference.reloadEnd(row === null ? undefined : row.phone);
        for (const filler of fillers.values()) if (filler.state === 'failed') filler.state = 'ended';
        await settleAll();
      } else if (step.step === 'warm') {
        store.getCached(LID);
        const deadline = Date.now() + 10_000;
        while (inner.pendingLookups.has(LID)) {
          if (Date.now() > deadline) throw new Error('the warm did not end');
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        const row = await repo.findOneBy({ lid: LID });
        if (!down && !reference.pending() && !inner.unsettledWrites.has(LID))
          reference.warm(row === null ? undefined : row.phone);
      } else if (step.step === 'peer') {
        await repo.upsert({ lid: LID, phone: PEER, sessionId: OTHER, isReported: true, updatedAt: new Date() }, [
          'lid',
        ]);
        peered = true;
      } else if (step.step === 'failReports' || step.step === 'failLookups') {
        // A sync while the database is down: each lid's write fails, past the bound of the failed-write marks.
        failingFillers = true;
        const sync = step.step === 'failReports' ? REPORT_FILLERS : LOOKUP_FILLERS;
        const kind = step.step === 'failReports' ? 'report' : 'lookup';
        for (const filler of sync) {
          if (kind === 'report') await store.remember(filler.lid, filler.engine, OWNER);
          else await store.rememberIfUnknown(filler.lid, filler.engine, OTHER);
          fillers.set(filler.lid, { kind, row: filler.row, engine: filler.engine, state: 'failed' });
        }
        failingFillers = false;
      } else {
        // The database is back and the first lid of the sync is reported again.
        const filler = [...fillers.values()].find(f => f.state === 'failed' && f.kind === 'report');
        const lid = REPORT_FILLERS.find(f => fillers.get(f.lid) === filler)?.lid;
        if (filler && lid && (await store.remember(lid, filler.engine, OWNER))) filler.state = 'landed';
      }
      if (step.step !== 'begin' && step.step !== 'settle') {
        // The environment can have left the lid out of the mirror without the script's say: it only reads that residency.
        if (!inner.lidToPhone.has(LID)) reference.held = undefined;
        await settleAll();
      }
      await checkLid(after);
      if (fillers.size > 0 || at === steps.length - 1) await checkFillers(after);
    }
    await Promise.allSettled(calling);
    gated = false;
    down = false;
    if (!failed && fillers.size === 0) {
      // Nothing failed and everything has landed: the readers answer exactly what the table holds.
      const settledRow = await repo.findOneBy({ lid: LID });
      const want = settledRow?.isReported ? settledRow.phone : null;
      const answer = await store.findPhoneForLid(own);
      if (answer !== want)
        unexpected('everything landed', `with no failure the lid answers ${String(answer)}, not ${String(want)}`);
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

  /** Every way of inserting the events, in order, after the steps: any number of them after the same step. */
  const inserted = (steps: Step[], events: Environment[]): Step[][] => {
    if (events.length === 0) return [steps];
    const out: Step[][] = [];
    const go = (from: number, left: Environment[], done: Step[]): void => {
      if (left.length === 0) return void out.push([...done, ...steps.slice(from)]);
      for (let slot = from; slot <= steps.length; slot++)
        go(slot, left.slice(1), [...done, ...steps.slice(from, slot), { step: left[0] }]);
    };
    go(0, events, []);
    return out.filter(list => list[0]?.step === 'begin');
  };

  /** Every list of calls, every ordering of their begins and landings, every landing succeeding or failing. */
  const schedules = function* (scope: Scope): Generator<{ init: Init; calls: CallSpec[]; steps: Step[] }> {
    for (const init of scope.inits) {
      for (const calls of scope.lists) {
        for (const order of orders(calls.length)) {
          let masks: Outcome[][] = [[]];
          for (let i = 0; i < calls.length; i++) masks = masks.flatMap(m => scope.outcomes.map(o => [...m, o]));
          for (const outcomes of masks) {
            if (outcomes.filter(o => o !== 'ok').length > scope.maxFailures) continue;
            let landing = 0;
            const steps: Step[] = order.map(kind =>
              kind === 'begin' ? { step: 'begin' } : { step: 'settle', outcome: outcomes[landing++] },
            );
            for (const events of scope.events)
              for (const list of inserted(steps, events)) yield { init, calls, steps: list };
          }
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

  const explore = async (scope: Scope): Promise<{ explored: number; problems: string[] }> => {
    const problems = new Map<string, string>();
    let explored = 0;
    for (const { init, calls, steps } of schedules(scope)) {
      explored++;
      const found = await run(init, calls, steps, scope.full);
      if (found.length && problems.size < 5) problems.set(found[0], describeRun(init, calls, steps));
    }
    return { explored, problems: [...problems].map(([problem, schedule]) => `${problem} (${schedule})`) };
  };

  const base: Omit<Scope, 'inits' | 'lists' | 'events'> = { outcomes: ['ok', 'fail'], maxFailures: 1, full: false };

  it('gives the lids of the script bits of their own, so that no lid is refused for the failure of another', () => {
    const lids = [LID, ...FILLER_LIDS, UNTOUCHED.lid, 'e0', 'e1', 'e2', 'e3', 'e4', 'e5'];
    for (const dropped of lids) {
      const store = new LidMappingStoreService(slow);
      (store as unknown as Internals).recordDropped(dropped);
      expect(lids.filter(lid => (store as unknown as Internals).markDropped(lid))).toEqual([dropped]);
    }
  });

  it('reports an answer that ignores a write that failed', async () => {
    const ignoring = jest.spyOn(LidMappingStoreService.prototype, 'findPhoneForLid').mockImplementation(async function (
      this: LidMappingStoreService,
      jid: string,
    ) {
      const repo = (this as unknown as { repo: Repository<LidMapping> }).repo;
      const row = await repo.findOne({ where: { lid: jid.split('@')[0] } });
      return row?.isReported ? row.phone : null;
    });
    try {
      const steps: Step[] = [{ step: 'begin' }, { step: 'settle', outcome: 'fail' }];
      const found = await run('reported', [CALLS.reportFirst], steps, false);
      expect(found.join('\n')).toContain('while a report is failed');
    } finally {
      ignoring.mockRestore();
    }
  });

  it('answers the lid no phone it no longer has, in every order of two calls', async () => {
    const names = ['reportStored', 'reportFirst', 'negative', 'lookupStored', 'lookupFirst'];
    const found = await explore({
      ...base,
      inits: ['reported'],
      lists: lists(names, 2),
      events: [[], ['evict'], ['reload']],
    });
    expect(found.explored).toBeGreaterThan(1000);
    expect(found.problems).toEqual([]);
  }, 600_000);

  it('answers the lid no phone it no longer has, when a negative lands before the reports begun after it', async () => {
    const calls = [CALLS.negative, CALLS.reportFirst, CALLS.reportSecond, CALLS.negative];
    const found = await explore({ ...base, inits: ['reported'], lists: [calls], events: [['evict']] });
    expect(found.explored).toBeGreaterThan(500);
    expect(found.problems).toEqual([]);
  }, 600_000);

  // A lookup revokes any reported row that names another phone, so one that fails leaves the lid refused, whatever the
  // mirror held and whichever way the row was written.
  it('answers the lid no phone when a lookup fails while another node writes the row', async () => {
    const found = await explore({
      ...base,
      inits: ['reported', 'display', 'none'],
      lists: [
        ...lists(['lookupStored', 'lookupFirst', 'reportFirst', 'negative'], 1),
        ...lists(['lookupStored', 'lookupFirst'], 2),
      ],
      events: [['peer'], ['peer', 'evict'], ['evict', 'peer']],
      outcomes: ['ok', 'fail', 'failAfter'],
      full: true,
    });
    expect(found.explored).toBeGreaterThan(3000);
    expect(found.problems).toEqual([]);
  }, 600_000);

  // A reload that is reading the table does not take a lid with a write under way from it, and the marks of the writes that
  // fail meanwhile are the only refusal left.
  it('answers the lid no phone it no longer has, when its writes fail while a reload reads the table', async () => {
    const found = await explore({
      ...base,
      inits: ['reported', 'display', 'none'],
      lists: lists(['reportFirst', 'reportSecond', 'negative', 'lookupFirst', 'lookupStored'], 2),
      events: [['reloadBegin', 'reloadEnd']],
    });
    expect(found.explored).toBeGreaterThan(4000);
    expect(found.problems).toEqual([]);
    const three = await explore({
      ...base,
      inits: ['reported'],
      lists: lists(['reportFirst', 'lookupFirst'], 3),
      events: [['reloadBegin', 'reloadEnd']],
    });
    expect(three.explored).toBeGreaterThan(3000);
    expect(three.problems).toEqual([]);
  }, 600_000);

  // A sync of more lids than the marks hold, while the database is down: the oldest marks go, and the lids they named answer
  // no phone, though no other lid does.
  it('answers the lid no phone it no longer has, when a sync fails past the failed-write marks', async () => {
    const found = await explore({
      ...base,
      inits: ['reported', 'display', 'none', 'negative'],
      lists: lists(['reportFirst', 'lookupFirst', 'lookupStored', 'negative'], 1),
      events: [
        ['failReports'],
        ['failLookups'],
        ['failReports', 'recover'],
        ['failReports', 'recover', 'evict'],
        ['failReports', 'evict'],
        ['failReports', 'warm'],
        ['failLookups', 'warm'],
        ['failReports', 'reloadBegin', 'reloadEnd'],
        ['failReports', 'peer'],
      ],
      full: true,
    });
    expect(found.explored).toBeGreaterThan(800);
    expect(found.problems).toEqual([]);
    const two = await explore({
      ...base,
      inits: ['reported', 'display', 'none'],
      lists: lists(['reportFirst', 'lookupFirst', 'negative'], 2),
      events: [['failReports'], ['failLookups'], ['failReports', 'recover', 'evict'], ['failReports', 'warm']],
    });
    expect(two.explored).toBeGreaterThan(5500);
    expect(two.problems).toEqual([]);
    // A third write keeps the entry of the lid under way after a lookup failed and its mark went.
    const three = await explore({
      ...base,
      inits: ['reported'],
      lists: lists(['reportStored', 'lookupStored', 'negative'], 3),
      events: [['failReports']],
    });
    expect(three.explored).toBeGreaterThan(3000);
    expect(three.problems).toEqual([]);
  }, 600_000);

  // With the table unreadable the readers answer from the mirror, which is judged as a row would be: a lid whose write
  // failed can have the row it distrusts warmed back into it, by an eviction or by a reload that read the table while the
  // write was under way.
  it('answers the lid no phone it no longer has, when the table cannot be read', async () => {
    const events: Environment[][] = [
      ['down'],
      ['down', 'up'],
      ['warm', 'down'],
      ['evict', 'warm', 'down'],
      ['evict', 'down', 'warm'],
      ['reloadBegin', 'reloadEnd', 'warm', 'down'],
    ];
    const found = await explore({
      ...base,
      inits: ['reported', 'display'],
      lists: lists(['reportFirst', 'lookupFirst', 'lookupStored', 'negative'], 1),
      events,
      full: true,
    });
    expect(found.explored).toBeGreaterThan(300);
    expect(found.problems).toEqual([]);
    const two = await explore({
      ...base,
      inits: ['reported', 'display'],
      lists: lists(['reportFirst', 'lookupFirst'], 2),
      events,
    });
    expect(two.explored).toBeGreaterThan(4200);
    expect(two.problems).toEqual([]);
  }, 600_000);
});
