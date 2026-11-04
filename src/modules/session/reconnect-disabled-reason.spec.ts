import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '44444444-4444-4444-8444-444444444444';

/**
 * `maxReconnectAttempts: 0` turns the gateway's reconnect off. The first drop then ends the episode at
 * once, and the reason recorded for it is what GET /sessions/:id serves as `lastError` next to the
 * status the row was left in. The two must describe the same state.
 */
describe('a drop with reconnect disabled', () => {
  it('records a reason that matches the status the session is left in', async () => {
    const stored = {
      id: ID,
      name: 'no-reconnect',
      phone: '628111',
      config: { maxReconnectAttempts: 0 },
      status: SessionStatus.DISCONNECTED,
      desiredState: null,
    } as unknown as Session;
    const repository = {
      findOne: jest.fn(() => Promise.resolve({ ...stored })),
      exists: jest.fn().mockResolvedValue(true),
      update: jest.fn((_where: unknown, patch: Partial<Session>) => {
        Object.assign(stored, patch);
        return Promise.resolve({ affected: 1 });
      }),
    };
    let callbacks: EngineEventCallbacks | undefined;
    const engine = {
      initialize: jest.fn((cb: EngineEventCallbacks) => {
        callbacks = cb;
        return Promise.resolve();
      }),
      getStatus: () => EngineStatus.READY,
      destroy: jest.fn().mockResolvedValue(undefined),
      forceDestroy: jest.fn().mockResolvedValue(undefined),
    };
    const errors = new SessionErrorStore();
    const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
    const lifecycle = new SessionEngineLifecycle(
      repository as never,
      {} as never,
      { create: jest.fn(() => engine), purgeSessionData: jest.fn() } as never,
      new EngineRegistry(),
      { clear: jest.fn() } as never,
      {} as never,
      errors,
      state as never,
      { clear: jest.fn() } as never,
      { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn() } as never,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
      { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
      {} as never,
    );

    await lifecycle.start(ID, { explicit: true });
    callbacks!.onDisconnected!('TIMEOUT');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const lastError = errors.attachTo({ ...stored }).lastError ?? '';
    expect(stored.status).toBe(SessionStatus.FAILED);
    // A failed session must not be described as one that was left disconnected.
    expect(lastError).not.toMatch(/left disconnected/);
    expect(lastError).toMatch(/marked failed/);
  });
});
