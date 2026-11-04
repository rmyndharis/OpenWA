import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '33333333-3333-4333-8333-333333333333';
const BOUND = '628111';
const OTHER = '628999';

/**
 * The account binding is the session row's `phone`: a ready link from a different number is refused
 * while the row carries one, and a terminal unlink clears it so the session can be linked afresh
 * (logout() does the same). What the gateway does after WhatsApp unlinks the device must not depend
 * on which path brings the next engine up: the automatic reconnect that shows the next QR, and a
 * start after a restart, both read a row whose phone the unlink cleared.
 */
function fixture({ holdInitOf }: { holdInitOf?: number } = {}) {
  const stored: Session = {
    id: ID,
    name: 'unlinked',
    phone: BOUND,
    pushName: 'Old',
    config: {},
    status: SessionStatus.DISCONNECTED,
    desiredState: null,
  } as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn().mockResolvedValue(true),
    update: jest.fn((where: unknown, patch: Partial<Session>) => {
      Object.assign(stored, patch);
      // prepareStart without an ownership service answers through `affected`.
      void where;
      return Promise.resolve({ affected: 1 });
    }),
  };
  const engines: Array<{ callbacks?: EngineEventCallbacks; rejectInit?: (error: Error) => void }> = [];
  const makeEngine = () => {
    const record: { callbacks?: EngineEventCallbacks; rejectInit?: (error: Error) => void } = {};
    const index = engines.push(record) - 1;
    return {
      initialize: jest.fn((cb: EngineEventCallbacks) => {
        record.callbacks = cb;
        // The engine `holdInitOf` names stays initializing until the case rejects it.
        if (index === holdInitOf) return new Promise<void>((_, reject) => (record.rejectInit = reject));
        return Promise.resolve();
      }),
      getStatus: () => EngineStatus.QR_READY,
      destroy: jest.fn().mockResolvedValue(undefined),
      forceDestroy: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    };
  };
  const factory = { create: jest.fn(makeEngine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const restrictions = { ...state, clearIfDisprovedByReady: jest.fn() };
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    state as never,
    restrictions as never,
    presence as never,
    { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn(), emitSessionAuthenticated: jest.fn() } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
  );
  const statusWrites = (status: SessionStatus): number =>
    repository.update.mock.calls.filter(([, patch]) => patch.status === status).length;
  return { lifecycle, registry, stored, engines, factory, statusWrites };
}

describe('a different number linking after WhatsApp unlinked the session', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is linked by the automatic reconnect, as it is by a start once the unlink cleared the phone', async () => {
    const f = fixture();
    await f.lifecycle.start(ID, { explicit: true });

    // WhatsApp unlinks the device: the row's phone is cleared and a reconnect is armed to show a QR.
    f.engines[0].callbacks!.onDisconnected!('LOGOUT');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.stored.phone).toBeNull();

    // The reconnect fires and brings up the next engine, which shows the QR a user scans.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.factory.create).toHaveBeenCalledTimes(2);

    // A different number scans that QR.
    f.engines[1].callbacks!.onReady!(OTHER, 'New');
    await jest.advanceTimersByTimeAsync(0);

    expect(f.statusWrites(SessionStatus.FAILED)).toBe(0);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it('still refuses a different number on the reconnect after a drop that kept the binding', async () => {
    const f = fixture();
    await f.lifecycle.start(ID, { explicit: true });

    // A transient drop: the phone stays, and so does the binding the next engine checks.
    f.engines[0].callbacks!.onDisconnected!('TIMEOUT');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.stored.phone).toBe(BOUND);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.factory.create).toHaveBeenCalledTimes(2);

    f.engines[1].callbacks!.onReady!(OTHER, 'New');
    await jest.advanceTimersByTimeAsync(0);

    expect(f.statusWrites(SessionStatus.FAILED)).toBe(1);
    expect(f.stored.phone).toBe(BOUND);
  });

  // The liveness watchdog reports an engine that still reads READY, which arms the reconnect; that engine
  // stays registered through the backoff and can then report the unlink itself.
  it.each(['LOGOUT', 'logged out'])(
    'is linked by a reconnect that was already pending when a %s report arrived',
    async reason => {
      const f = fixture();
      await f.lifecycle.start(ID, { explicit: true });
      await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, 'liveness probe failed (watchdog)');

      f.engines[0].callbacks!.onDisconnected!(reason);
      await jest.advanceTimersByTimeAsync(0);
      expect(f.stored.phone).toBeNull();

      await jest.advanceTimersByTimeAsync(10_000);
      expect(f.factory.create).toHaveBeenCalledTimes(2);
      f.engines[1].callbacks!.onReady!(OTHER, 'New');
      await jest.advanceTimersByTimeAsync(0);

      expect(f.statusWrites(SessionStatus.FAILED)).toBe(0);
      expect(f.stored.phone).toBe(OTHER);
      expect(f.stored.status).toBe(SessionStatus.READY);
    },
  );

  it('still refuses a different number after a drop that kept the binding arrived while a reconnect was pending', async () => {
    const f = fixture();
    await f.lifecycle.start(ID, { explicit: true });
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, 'liveness probe failed (watchdog)');

    f.engines[0].callbacks!.onDisconnected!('TIMEOUT');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.stored.phone).toBe(BOUND);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.factory.create).toHaveBeenCalledTimes(2);

    f.engines[1].callbacks!.onReady!(OTHER, 'New');
    await jest.advanceTimersByTimeAsync(0);

    expect(f.statusWrites(SessionStatus.FAILED)).toBe(1);
    expect(f.stored.phone).toBe(BOUND);
  });

  it('is linked by the next attempt after a reconnect attempt reported the unlink and then failed to initialize', async () => {
    const f = fixture({ holdInitOf: 1 });
    await f.lifecycle.start(ID, { explicit: true });
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, 'liveness probe failed (watchdog)');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.factory.create).toHaveBeenCalledTimes(2);

    // The attempt's own engine reports the unlink while it initializes; then its init rejects, and its
    // failure path reschedules with the row that attempt was started from.
    f.engines[1].callbacks!.onDisconnected!('logged out');
    await jest.advanceTimersByTimeAsync(0);
    expect(f.stored.phone).toBeNull();
    f.engines[1].rejectInit!(new Error('connection closed'));
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(f.factory.create).toHaveBeenCalledTimes(3);
    f.engines[2].callbacks!.onReady!(OTHER, 'New');
    await jest.advanceTimersByTimeAsync(0);

    expect(f.statusWrites(SessionStatus.FAILED)).toBe(0);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it('control: a start after the unlink links the different number', async () => {
    const f = fixture();
    f.stored.phone = null;

    await f.lifecycle.start(ID, { explicit: true });
    f.engines[0].callbacks!.onReady!(OTHER, 'New');
    await jest.advanceTimersByTimeAsync(0);

    expect(f.statusWrites(SessionStatus.FAILED)).toBe(0);
    expect(f.stored.phone).toBe(OTHER);
  });
});
