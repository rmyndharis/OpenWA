import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '88888888-8888-4888-8888-888888888888';
const BOUND = '628111';

function fixture() {
  const stored = {
    id: ID,
    name: 'disconnect-read-retry-controls',
    phone: BOUND,
    config: { reconnectBaseDelay: 1000 },
    status: SessionStatus.READY,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;

  let rowPresent = true;
  const repository = {
    findOne: jest.fn(() => Promise.resolve(rowPresent ? { ...stored } : null)),
    exists: jest.fn(() => Promise.resolve(rowPresent)),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      if (!rowPresent) return Promise.resolve({ affected: 0 });
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };

  const emptyMessageQuery = () => {
    const query: Record<string, jest.Mock> = { getRawMany: jest.fn().mockResolvedValue([]) };
    for (const name of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
      query[name] = jest.fn().mockReturnValue(query);
    }
    return query;
  };
  const messageRepository = {
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(emptyMessageQuery),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const manager = {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    remove: jest.fn(() => {
      rowPresent = false;
      return Promise.resolve(stored);
    }),
  };
  const dataSource = {
    options: { type: 'better-sqlite3' },
    getRepository: jest.fn(() => messageRepository),
    transaction: jest.fn(async (cb: (m: unknown) => Promise<void>) => cb(manager)),
  };

  const engines: Array<{
    initialize: jest.Mock;
    destroy: jest.Mock;
    forceDestroy: jest.Mock;
    disconnect: jest.Mock;
    logout: jest.Mock;
  }> = [];

  const factory = {
    create: jest.fn(() => {
      const engine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        logout: jest.fn().mockResolvedValue(undefined),
      };
      engines.push(engine);
      return engine;
    }),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };

  const errors = new Map<string, string>();
  const errorStore = {
    attachTo: <T>(value: T): T => value,
    clear: jest.fn((id: string) => errors.delete(id)),
    set: jest.fn((id: string, reason: string) => errors.set(id, reason)),
    get: jest.fn((id: string) => errors.get(id)),
  };
  const restrictions = { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() };
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
  const events = {
    emitSessionStatus: jest.fn(),
    emitSessionDisconnected: jest.fn(),
    emitSessionAuthenticated: jest.fn(),
    emitQRCode: jest.fn(),
  };
  const audit = { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    dataSource as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    errorStore as never,
    restrictions as never,
    presence as never,
    events as never,
    webhooks as never,
    hooks as never,
    { clearSession: jest.fn() } as never,
    undefined,
    undefined,
    audit as never,
  );

  const handled = jest.spyOn(lifecycle, 'handleEngineDisconnected');
  const settled = async (): Promise<void> => {
    await Promise.all(handled.mock.results.map(result => result.value as Promise<void>));
  };
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  const unlinkAudits = (): unknown[][] =>
    (audit.logWarn.mock.calls as unknown[][]).filter(([action]) => action === AuditAction.SESSION_DISCONNECTED);
  const announced = (): string[] =>
    (webhooks.dispatch.mock.calls as [string, string, { reason: string }][])
      .filter(([, event]) => event === 'session.disconnected')
      .map(([, , payload]) => payload.reason);
  const disown = (): void => {
    (lifecycle as unknown as { ownership?: { owns: () => boolean } }).ownership = { owns: () => false };
  };

  return {
    lifecycle,
    registry,
    repository,
    stored,
    engines,
    callbacksOf,
    settled,
    unlinkAudits,
    announced,
    disown,
  };
}

describe('terminal unlink carried by a pending disconnect read retry across lifecycle controls', () => {
  afterEach(() => jest.useRealTimers());

  it('clears the phone binding and records SESSION_DISCONNECTED when stop() runs while a LOGOUT read retry is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    await f.lifecycle.stop(ID);

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('records SESSION_DISCONNECTED and announces the unlink when logout() runs while a LOGOUT read retry is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    await f.lifecycle.logout(ID);

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the phone binding and records SESSION_DISCONNECTED when forceKill() runs while an UNPAIRED read retry is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('UNPAIRED');
    await f.settled();

    await f.lifecycle.forceKill(ID);

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['UNPAIRED']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('records SESSION_DISCONNECTED and announces the unlink when delete() runs while a LOGOUT read retry is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    await f.lifecycle.delete(ID);

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('completes the unlink and clears the retry timer when stopOrphanEngines() runs while a LOGOUT read retry is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    await f.lifecycle.stopOrphanEngines([ID]);

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the phone binding and records SESSION_DISCONNECTED when shutdown() runs while a logged-out read retry is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('logged out');
    await f.settled();

    await f.lifecycle.shutdown();

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['logged out']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the phone binding and writes no unlink audit when stop() cancels a non-unlink read retry', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await f.settled();

    await f.lifecycle.stop(ID);

    expect(f.stored.phone).toBe(BOUND);
    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.announced()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('audits the unlink without clearing phone on the row when stopOrphanEngines() runs after ownership was lost', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();
    f.disown();

    await f.lifecycle.stopOrphanEngines([ID]);

    expect(f.stored.phone).toBe(BOUND);
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('records SESSION_DISCONNECTED and announces the unlink only once when stop() runs while the read retry findOne is in flight and engine.disconnect() is pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });
    let finishDisconnect!: () => void;
    const disconnectPending = new Promise<void>(resolve => {
      finishDisconnect = resolve;
    });
    f.engines[0].disconnect.mockImplementation(() => disconnectPending);

    f.repository.findOne
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead);
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    const stopping = f.lifecycle.stop(ID);
    await new Promise(resolve => setImmediate(resolve));

    finishRetryRead({ ...f.stored });
    await f.settled();
    finishDisconnect();
    await stopping;

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not double-audit or double-announce when a second failed disconnect read arrives while retry1 findOne is in flight and stop() runs during teardown', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });
    let finishDisconnect!: () => void;
    const disconnectPending = new Promise<void>(resolve => {
      finishDisconnect = resolve;
    });
    f.engines[0].disconnect.mockImplementation(() => disconnectPending);

    f.repository.findOne
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead)
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await Promise.resolve();
    await Promise.resolve();

    const stopping = f.lifecycle.stop(ID);
    await new Promise(resolve => setImmediate(resolve));

    finishRetryRead({ ...f.stored });
    await f.settled();
    finishDisconnect();
    await stopping;

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not drop a LOGOUT unlink when a non-unlink disconnect fails its read while retry1 findOne is in flight and stop() runs', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });

    f.repository.findOne
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead)
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await Promise.resolve();
    await Promise.resolve();

    await f.lifecycle.stop(ID);
    finishRetryRead({ ...f.stored });
    await f.settled();

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not drop a LOGOUT unlink when an earlier watchdog read answers while retry1 findOne is in flight and stop() runs', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishWatchdogRead!: (row: Session | null) => void;
    const watchdogRead = new Promise<Session | null>(resolve => {
      finishWatchdogRead = resolve;
    });
    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });

    f.repository.findOne
      .mockImplementationOnce(() => watchdogRead)
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead);

    const watchdogReason = 'liveness probe failed (watchdog)';
    const watchdog = f.lifecycle.handleEngineDisconnected(ID, engine, watchdogReason);
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    finishWatchdogRead({ ...f.stored });
    await watchdog;

    await f.lifecycle.stop(ID);
    finishRetryRead({ ...f.stored });
    await f.settled();

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual([watchdogReason, 'LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not double-record or double-announce when an earlier slow LOGOUT read answers while a LOGOUT read retry findOne is in flight', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishFirstLogoutRead!: (row: Session | null) => void;
    const firstLogoutRead = new Promise<Session | null>(resolve => {
      finishFirstLogoutRead = resolve;
    });
    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });

    f.repository.findOne
      .mockImplementationOnce(() => firstLogoutRead)
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead);

    const firstLogout = f.lifecycle.handleEngineDisconnected(ID, engine, 'LOGOUT');
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    finishFirstLogoutRead({ ...f.stored });
    await firstLogout;

    finishRetryRead({ ...f.stored });
    await f.settled();
    await f.lifecycle.stop(ID);

    expect(f.stored.phone).toBeNull();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not double-announce when an earlier watchdog read answers while a non-unlink read retry findOne is in flight', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishWatchdogRead!: (row: Session | null) => void;
    const watchdogRead = new Promise<Session | null>(resolve => {
      finishWatchdogRead = resolve;
    });
    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });

    f.repository.findOne
      .mockImplementationOnce(() => watchdogRead)
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead);

    const watchdogReason = 'liveness probe failed (watchdog)';
    const watchdog = f.lifecycle.handleEngineDisconnected(ID, engine, watchdogReason);
    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    finishWatchdogRead({ ...f.stored });
    await watchdog;

    finishRetryRead({ ...f.stored });
    await f.settled();
    await f.lifecycle.stop(ID);

    expect(f.stored.phone).toBe(BOUND);
    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.announced()).toEqual([watchdogReason]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not clobber READY or arm a reconnect when onReady fires while retry1 findOne is in flight', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let finishRetryRead!: (row: Session | null) => void;
    const retryRead = new Promise<Session | null>(resolve => {
      finishRetryRead = resolve;
    });

    f.repository.findOne
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockImplementationOnce(() => retryRead);

    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    f.callbacksOf(0).onReady?.(BOUND, 'Self');
    await Promise.resolve();

    finishRetryRead({ ...f.stored });
    await f.settled();

    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.announced()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
