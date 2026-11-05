import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { SessionStoppedException } from './session-engine-controls';

const ID = '99999999-9999-4999-8999-999999999999';

const tick = (): Promise<unknown> => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const stored = {
    id: ID,
    name: 'stop-mark-start',
    phone: null,
    config: {},
    status: SessionStatus.DISCONNECTED,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn(() => Promise.resolve(true)),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const engines: Array<Record<string, jest.Mock>> = [];
  const factory = {
    create: jest.fn(() => {
      const engine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        getStatus: jest.fn(() => EngineStatus.DISCONNECTED),
      };
      engines.push(engine);
      return engine;
    }),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    { options: { type: 'better-sqlite3' } } as never,
    factory as never,
    new EngineRegistry(),
    { clear: jest.fn() } as never,
    {} as never,
    { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() } as never,
    { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() } as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    {
      emitSessionStatus: jest.fn(),
      emitSessionDisconnected: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitQRCode: jest.fn(),
    } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    { clearSession: jest.fn() } as never,
    undefined,
    { isShuttingDown: () => false } as never,
    { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) } as never,
  );
  /** The next session read of the start waits until the case answers it. */
  const holdRead = (): (() => void) => {
    let answer!: () => void;
    repository.findOne.mockImplementationOnce(
      () => new Promise<Session>(resolve => (answer = () => resolve({ ...stored }))),
    );
    return () => answer();
  };
  return { lifecycle, engines, holdRead };
}

// An explicit start launches over a mark that was there when it began, a stop that finished earlier, and yields to one
// set after it began. A mark that remains because a newer operation dropped its own is not one set after it began.
describe('a start beside the stop marks of its session', () => {
  it('launches when the newer mark it saw is dropped and only the mark of an earlier stop is left', async () => {
    const f = fixture();
    f.lifecycle.markStopping(ID); // a stop that finished earlier leaves its mark
    const newer = f.lifecycle.markStopping(ID); // another operation is in flight when the start begins
    const answer = f.holdRead();

    const starting = f.lifecycle.start(ID, { explicit: true });
    await tick();
    f.lifecycle.clearStopping(ID, newer); // it failed before acting and dropped its own mark
    answer();
    await starting;

    expect(f.engines).toHaveLength(1);
    await f.lifecycle.shutdown();
  });

  it('is refused when a stop sets its mark after the start began', async () => {
    const f = fixture();
    f.lifecycle.markStopping(ID);
    const answer = f.holdRead();

    const starting = f.lifecycle.start(ID, { explicit: true }).catch((error: unknown) => error);
    await tick();
    f.lifecycle.markStopping(ID);
    answer();

    expect(await starting).toBeInstanceOf(SessionStoppedException);
    expect(f.engines).toHaveLength(0);
    await f.lifecycle.shutdown();
  });
});
