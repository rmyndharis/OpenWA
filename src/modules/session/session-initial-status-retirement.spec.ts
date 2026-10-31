import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { ENGINE_TEARDOWN_TIMEOUT_MS, SessionLifecycleFences } from './session-lifecycle-fences';

const ID = '11111111-1111-4111-8111-111111111111';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => void): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      check();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  check();
}

describe('initial status replies after engine retirement', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function fixture() {
    let row: Session | null = { id: ID, name: 'pending-session', phone: null, config: {} } as Session;
    let firstInitial = true;
    const reply = deferred();
    const committed: SessionStatus[] = [];
    const emitSessionStatus = jest.fn();
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
    const repository = {
      findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
      exists: jest.fn().mockResolvedValue(false),
      update: jest.fn((id: string, patch: Partial<Session>) => {
        expect(id).toBe(ID);
        if (row) Object.assign(row, patch);
        if (patch.status) committed.push(patch.status);
        // The database effect precedes its delayed reply; no commit reordering is simulated.
        if (patch.status === SessionStatus.INITIALIZING && firstInitial) {
          firstInitial = false;
          return reply.promise.then(() => ({ affected: 1 }));
        }
        return Promise.resolve({ affected: row ? 1 : 0 });
      }),
    };
    const query = {
      select: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      limit: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    for (const method of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit'] as const) {
      query[method].mockReturnValue(query);
    }
    const manager = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      remove: jest.fn(() => {
        row = null;
        return Promise.resolve();
      }),
    };
    const dataSource = {
      options: { type: 'postgres' },
      getRepository: (target: unknown) => ({
        target,
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: () => query,
      }),
      transaction: jest.fn((run: (manager: unknown) => Promise<unknown>) => run(manager)),
    };
    const createEngine = () => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      forceDestroy: jest.fn().mockResolvedValue(undefined),
    });
    const engines: Array<ReturnType<typeof createEngine>> = [];
    const factory = {
      create: jest.fn(() => {
        const engine = createEngine();
        engines.push(engine);
        return engine;
      }),
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };
    const registry = new EngineRegistry();
    const lifecycle = new SessionEngineLifecycle(
      repository as never,
      dataSource as never,
      factory as never,
      registry,
      {} as never,
      {} as never,
      state as never,
      state as never,
      state as never,
      { emitSessionStatus } as never,
      { dispatch } as never,
      { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
      {} as never,
    );
    const initialize = (): Promise<void> =>
      (lifecycle as unknown as { initializeEngine(id: string, session: Session): Promise<void> }).initializeEngine(ID, {
        ...row!,
      });
    const initial = initialize().then(
      () => undefined,
      (error: unknown) => error,
    );
    return {
      reply,
      committed,
      emitSessionStatus,
      dispatch,
      registry,
      lifecycle,
      initialize,
      initial,
      engines,
      row: () => row,
    };
  }

  async function retire(f: ReturnType<typeof fixture>, action: 'stop' | 'delete'): Promise<void> {
    const awaitingStatus = jest.spyOn(SessionLifecycleFences.prototype, 'awaitInitialStatus');
    const control = action === 'stop' ? f.lifecycle.stop(ID) : f.lifecycle.delete(ID);
    void control.catch(() => undefined);
    await waitFor(() => expect(awaitingStatus).toHaveBeenCalledWith(ID, f.engines[0]));
    await jest.advanceTimersByTimeAsync(ENGINE_TEARDOWN_TIMEOUT_MS + 1);
    await control;
    expect(f.registry.has(ID)).toBe(false);
    expect(f.engines[0].initialize).not.toHaveBeenCalled();
  }

  it.each([
    ['stop', false],
    ['delete', false],
    ['stop', true],
    ['delete', true],
  ] as const)('keeps %s notifications final when an initial reply rejects=%s', async (action, rejected) => {
    const f = fixture();
    try {
      expect(f.committed).toEqual([SessionStatus.INITIALIZING]);
      await retire(f, action);
      const events = f.emitSessionStatus.mock.calls.slice();
      const webhooks = f.dispatch.mock.calls.slice();
      const failure = new Error('delayed reply failed');
      if (rejected) f.reply.reject(failure);
      else f.reply.resolve();
      expect(await f.initial).toBe(rejected ? failure : undefined);
      expect(f.emitSessionStatus.mock.calls).toEqual(events);
      expect(f.dispatch.mock.calls).toEqual(webhooks);
      expect(f.row()?.status ?? null).toBe(action === 'stop' ? SessionStatus.DISCONNECTED : null);
      expect(f.committed).toEqual(
        action === 'stop' ? [SessionStatus.INITIALIZING, SessionStatus.DISCONNECTED] : [SessionStatus.INITIALIZING],
      );
    } finally {
      f.reply.resolve();
      await f.initial;
    }
  });

  it('announces a delayed initial reply while the same engine remains current', async () => {
    const f = fixture();
    try {
      await jest.advanceTimersByTimeAsync(ENGINE_TEARDOWN_TIMEOUT_MS + 1);
      f.reply.resolve();
      expect(await f.initial).toBeUndefined();
      expect(f.engines[0].initialize).toHaveBeenCalledTimes(1);
      expect(f.emitSessionStatus).toHaveBeenCalledWith(ID, SessionStatus.INITIALIZING);
      expect(f.dispatch).toHaveBeenCalledWith(ID, 'session.status', {
        sessionId: ID,
        status: SessionStatus.INITIALIZING,
      });
    } finally {
      f.reply.resolve();
      await f.initial;
    }
  });

  it('preserves a replacement READY announcement when an older initial reply settles', async () => {
    const f = fixture();
    try {
      await retire(f, 'stop');
      f.lifecycle.clearStopping(ID);
      await f.initialize();
      const replacement = f.registry.get(ID);
      await f.lifecycle.updateStatus(ID, SessionStatus.READY);
      const events = f.emitSessionStatus.mock.calls.slice();
      const webhooks = f.dispatch.mock.calls.slice();
      f.reply.resolve();
      expect(await f.initial).toBeUndefined();
      expect(f.registry.get(ID)).toBe(replacement);
      expect(f.row()?.status).toBe(SessionStatus.READY);
      expect(f.emitSessionStatus.mock.calls).toEqual(events);
      expect(f.dispatch.mock.calls).toEqual(webhooks);
    } finally {
      f.reply.resolve();
      await f.initial;
    }
  });
});
