import { BadGatewayException, ConflictException } from '@nestjs/common';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';

const ID = '99999999-9999-4999-8999-999999999991';
const NAME = 'concurrent-delete-logout';

function fixture() {
  const stored: Session = {
    id: ID,
    name: NAME,
    phone: '628111',
    config: {},
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

  let resolveForceDestroy!: () => void;
  let resolveLogout!: () => void;
  const engine = {
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn(
      () =>
        new Promise<void>(res => {
          resolveForceDestroy = res;
        }),
    ),
    disconnect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn(
      () =>
        new Promise<void>(res => {
          resolveLogout = res;
        }),
    ),
  };

  const factory = {
    create: jest.fn(() => engine),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };

  const errorStore = {
    attachTo: <T>(value: T): T => value,
    clear: jest.fn(),
    set: jest.fn(),
    get: jest.fn(),
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

  return {
    lifecycle,
    factory,
    dataSource,
    engine,
    get rowPresent() {
      return rowPresent;
    },
    get resolveForceDestroy() {
      return resolveForceDestroy;
    },
    get resolveLogout() {
      return resolveLogout;
    },
  };
}

describe('concurrent delete() and logout() across the awaitInitialStatus microtask window', () => {
  afterEach(() => jest.useRealTimers());

  it('catches a concurrent logout at delete fence #2 rather than deleting the row while engine.logout() is still running', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
    const f = fixture();
    await f.lifecycle.start(ID);

    // delete(ID) passes fence #1 and begins tearing down the live engine via forceDestroy().
    const deleteCall = f.lifecycle.delete(ID).then(
      () => undefined,
      (err: unknown) => err,
    );
    while (f.engine.forceDestroy.mock.calls.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(f.engine.forceDestroy).toHaveBeenCalledTimes(1);

    // A concurrent logout(ID) starts while engine is still in the registry, followed by forceDestroy() resolving.
    const logoutCall = f.lifecycle.logout(ID).then(
      () => undefined,
      (err: unknown) => err,
    );
    f.resolveForceDestroy();

    // Advance past the 10s teardown/fence deadline while engine.logout() remains wedged.
    await jest.advanceTimersByTimeAsync(10_000);
    const deleteErr = (await deleteCall) as { response?: { code?: string } } | undefined;
    const logoutErr = await logoutCall;

    expect(logoutErr).toBeInstanceOf(BadGatewayException);
    // Because engine.logout() is still wedged on the session's credentials, delete() must refuse at fence #2 (409 SESSION_NAME_TEARDOWN_PENDING) and keep the row and credentials intact.
    expect(deleteErr).toBeInstanceOf(ConflictException);
    expect(deleteErr?.response?.code).toBe('SESSION_NAME_TEARDOWN_PENDING');
    expect(f.rowPresent).toBe(true);
    expect(f.factory.purgeSessionData).not.toHaveBeenCalled();

    f.resolveLogout();
  });

  it('waits at delete fence #2 until a concurrent logout finishes before removing the row and purging auth data', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
    const f = fixture();
    await f.lifecycle.start(ID);

    const deleteCall = f.lifecycle.delete(ID);
    while (f.engine.forceDestroy.mock.calls.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }

    const logoutCall = f.lifecycle.logout(ID).catch((err: unknown) => err);
    f.resolveForceDestroy();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(f.engine.logout).toHaveBeenCalledTimes(1);
    expect(f.rowPresent).toBe(true);
    expect(f.factory.purgeSessionData).not.toHaveBeenCalled();

    f.resolveLogout();
    await Promise.all([deleteCall, logoutCall]);
    expect(f.rowPresent).toBe(false);
    expect(f.factory.purgeSessionData).toHaveBeenCalledTimes(1);
  });
});
