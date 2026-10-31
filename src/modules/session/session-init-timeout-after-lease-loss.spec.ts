import { IsNull } from 'typeorm';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '55555555-5555-4555-8555-555555555555';
const ME = 'node-a';
const PEER = 'node-b';

type Where = string | Record<string, unknown> | Array<Record<string, unknown>>;

/** Whether an update's where clause selects the stored row, for the id, nodeId and IsNull() forms used here. */
function selects(where: Where, row: Session): boolean {
  if (typeof where === 'string') return where === row.id;
  const clauses = Array.isArray(where) ? where : [where];
  return clauses.some(clause =>
    Object.entries(clause).every(([key, value]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object' && (value as { type?: string }).type === IsNull().type) {
        return actual == null;
      }
      if (value && typeof value === 'object') return true; // other operators are not under test here
      return actual === value;
    }),
  );
}

/**
 * Once this node has lost a session's lease, the row belongs to the peer that claimed it: the local
 * engine is torn down and nothing this node still has in flight for that session may write the row
 * (docs/31 INV-6). An engine whose initialization is still pending when the loss is noticed has an init
 * deadline still armed; when it fires during the lease-loss teardown it must leave the peer's status alone.
 */
function fixture(nodeId: string | null = ME) {
  const stored: Session = {
    id: ID,
    name: 'lease-lost-during-init',
    phone: '628111',
    config: {},
    status: SessionStatus.DISCONNECTED,
    desiredState: null,
    nodeId,
  } as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn().mockResolvedValue(true),
    update: jest.fn((where: Where, patch: Partial<Session>) => {
      const hit = selects(where, stored);
      if (hit) Object.assign(stored, patch);
      return Promise.resolve({ affected: hit ? 1 : 0 });
    }),
  };
  // initialize() never settles (a navigation that never completes), and a graceful destroy() of that
  // wedged browser never settles either; the SIGKILL in forceDestroy() does.
  const engine = {
    initialize: jest.fn(() => new Promise<void>(() => undefined)),
    getStatus: () => EngineStatus.INITIALIZING,
    destroy: jest.fn(() => new Promise<void>(() => undefined)),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const restrictions = { ...state, clearIfDisprovedByReady: jest.fn() };
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
  const events = {
    emitSessionStatus: jest.fn(),
    emitSessionDisconnected: jest.fn(),
    emitSessionAuthenticated: jest.fn(),
  };
  let owned = true;
  const ownership = {
    nodeId: ME,
    owns: jest.fn(() => owned),
    prepareStart: jest.fn().mockResolvedValue(true),
  };
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
    events as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    ownership as never,
  );
  /** The peer takes the lapsed lease over and its own engine reports ready; this node notices the loss. */
  const peerAdopts = (): void => {
    stored.nodeId = PEER;
    stored.status = SessionStatus.READY;
    owned = false;
  };
  return { lifecycle, registry, stored, events, peerAdopts };
}

describe('an init deadline that fires after this node lost the lease', () => {
  const previous = process.env.WWEBJS_AUTH_TIMEOUT_MS;
  beforeEach(() => {
    delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previous === undefined) delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    else process.env.WWEBJS_AUTH_TIMEOUT_MS = previous;
  });

  it("leaves the peer's status on the row while the lease-loss teardown is still running", async () => {
    const f = fixture();
    const start = f.lifecycle.start(ID).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.registry.has(ID)).toBe(true);

    // 55 s into the init, the heartbeat finds the claim gone and tears the local engine down
    // (SessionService's onLeaseLoss handler), which writes no row.
    await jest.advanceTimersByTimeAsync(55_000);
    f.peerAdopts();
    const orphanStop = f.lifecycle.stopOrphanEngines([ID]);

    // The 60 s init deadline fires while the graceful destroy of the wedged engine is still pending.
    await jest.advanceTimersByTimeAsync(30_000);
    await orphanStop;
    await start;

    // The fake repository applies a write only to a row its where clause selects.
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.stored.nodeId).toBe(PEER);
    expect(f.events.emitSessionStatus).not.toHaveBeenCalledWith(ID, SessionStatus.DISCONNECTED);
  });

  it.each([
    ['still holds', ME],
    ['has no owner of', null],
  ])('still marks the session disconnected when this node %s the row', async (_case, nodeId) => {
    const f = fixture(nodeId);
    const start = f.lifecycle.start(ID).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(60_000);
    await start;

    expect(f.registry.has(ID)).toBe(false);
    expect(f.stored.status).toBe(SessionStatus.DISCONNECTED);
    expect(f.events.emitSessionStatus).toHaveBeenLastCalledWith(ID, SessionStatus.DISCONNECTED);
  });
});
