import { BadRequestException } from '@nestjs/common';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import type { EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '66666666-6666-4666-8666-666666666666';

/** Let every queued microtask and the I/O turns behind them run, with timers faked. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

/**
 * A whatsapp-web.js unlink starts the profile removal and reports the disconnect in the same tick, so the
 * reconnect it arms tears the old engine down and then waits on that removal. A start sent meanwhile finds
 * no engine registered and waits on the same removal. When it settles, the reconnect resumes first and
 * launches its engine; the start must not launch a second one over it.
 */
function fixture() {
  const stored = {
    id: ID,
    name: 'start-reconnect-fence',
    phone: '628111',
    config: { reconnectBaseDelay: 1000 },
    status: SessionStatus.READY,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn().mockResolvedValue(true),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const engines: Array<Record<'initialize' | 'destroy' | 'forceDestroy' | 'disconnect' | 'logout', jest.Mock>> = [];
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
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    state as never,
    { ...state, clearIfDisprovedByReady: jest.fn() } as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn(), emitSessionAuthenticated: jest.fn() } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
    undefined,
    undefined,
    { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) } as never,
  );
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  return { lifecycle, registry, engines, callbacksOf };
}

describe('a start that waits on the credential teardown a reconnect waits on', () => {
  afterEach(() => jest.useRealTimers());

  it('leaves the session with the one engine the reconnect launched', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let removed!: () => void;
    f.callbacksOf(0).onCredentialTeardownStarted?.(new Promise<void>(resolve => (removed = resolve)));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    // The backoff runs out, and the reconnect tears the old engine down and waits on the removal.
    await jest.advanceTimersByTimeAsync(3_000);
    await drain();
    expect(f.engines[0].destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);

    const start = f.lifecycle.start(ID).catch((error: unknown) => error);
    await drain();
    removed();
    await drain();

    const live: unknown = f.registry.get(ID);
    const leftRunning = f.engines
      .filter(engine => engine.initialize.mock.calls.length > 0 && engine !== live)
      .filter(engine => engine.destroy.mock.calls.length + engine.forceDestroy.mock.calls.length === 0)
      .map(engine => f.engines.indexOf(engine));
    expect(leftRunning).toEqual([]);
    expect(live).toBe(f.engines[1]);
    expect(f.engines).toHaveLength(2);
    expect(await start).toBeInstanceOf(BadRequestException);
  });
});
