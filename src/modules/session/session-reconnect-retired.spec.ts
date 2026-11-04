import { SessionEngineLifecycle, type ReconnectState } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session } from './entities/session.entity';

const ID = '11111111-1111-4111-8111-111111111111';

function fixture(row: Partial<Session>) {
  const stored = { id: ID, name: 'retired-reconnect', phone: '628111', config: {}, ...row } as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn().mockResolvedValue(false),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const engine = {
    initialize: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
  };
  const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    {} as never,
    {} as never,
    state as never,
    state as never,
    state as never,
    { emitSessionStatus: jest.fn() } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
  );
  const reconnect = (reconnectState: ReconnectState): Promise<void> =>
    (
      lifecycle as unknown as {
        executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void>;
      }
    ).executeReconnect(ID, { ...stored }, reconnectState);
  const states = (): Map<string, ReconnectState> =>
    (lifecycle as unknown as { reconnectStates: Map<string, ReconnectState> }).reconnectStates;
  return { lifecycle, registry, engine, reconnect, states };
}

describe('a reconnect that finishes initializing for a stopped session', () => {
  it('leaves nothing pending once the engine it built is retired', async () => {
    const f = fixture({ desiredState: 'stopped' });
    const state: ReconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
    f.states().set(ID, state);

    await f.reconnect(state);

    expect(f.engine.destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    expect(f.lifecycle.isEngineActive(ID)).toBe(false);
    expect(f.lifecycle.startSlotHolders().has(ID)).toBe(false);
  });

  it('keeps the engine and the pending attempt of a session that is still wanted', async () => {
    const f = fixture({ desiredState: null });
    const state: ReconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
    f.states().set(ID, state);

    await f.reconnect(state);

    expect(f.engine.destroy).not.toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(true);
    expect(f.lifecycle.isEngineActive(ID)).toBe(true);
  });
});
