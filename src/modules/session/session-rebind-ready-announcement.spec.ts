import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '44444444-4444-4444-8444-444444444444';
const BOUND = '628555';
const STRANGER = '628999';

/**
 * Both engines set the linked number, report READY through onStateChanged, and only then call onReady, where the
 * account binding refuses a different number. The status the refused link reports must not reach the row or any
 * consumer as ready first; every link the binding accepts still does.
 */
async function link(boundPhone: string | null, linkedPhone: string) {
  const stored = {
    id: ID,
    name: 'rebind-ready-announcement',
    phone: boundPhone,
    config: {},
    status: SessionStatus.QR_READY,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const statusWrites: string[] = [];
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      if (patch.status) statusWrites.push(patch.status);
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const engine = {
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    getPhoneNumber: jest.fn(() => linkedPhone),
  };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    { options: { type: 'better-sqlite3' } } as never,
    { create: jest.fn(() => engine), purgeSessionData: jest.fn() } as never,
    new EngineRegistry(),
    { clear: jest.fn() } as never,
    {} as never,
    { attachTo: <T>(v: T): T => v, clear: jest.fn(), set: jest.fn(), get: jest.fn() } as never,
    { attachTo: <T>(v: T): T => v, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() } as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    {
      emitSessionStatus: jest.fn(),
      emitSessionDisconnected: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitQRCode: jest.fn(),
    } as never,
    webhooks as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    { clearSession: jest.fn() } as never,
    undefined,
    undefined,
    { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) } as never,
  );

  await lifecycle.start(ID);
  const callbacks = (engine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  statusWrites.length = 0;

  callbacks.onStateChanged?.(EngineStatus.READY);
  callbacks.onReady?.(linkedPhone, 'Linked');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));

  const announcedStatuses = (webhooks.dispatch.mock.calls as [string, string, { status?: string }][])
    .filter(([, event]) => event === 'session.status')
    .map(([, , payload]) => payload.status);
  return { engine, stored, statusWrites, announcedStatuses };
}

describe('a ready link reported to a session bound to a number', () => {
  it('is never announced or stored as ready when another number linked it', async () => {
    const { engine, stored, statusWrites, announcedStatuses } = await link(BOUND, STRANGER);

    expect(engine.logout).toHaveBeenCalled();
    expect(stored.status).toBe(SessionStatus.FAILED);
    expect(stored.phone).toBe(BOUND);
    expect(announcedStatuses).not.toContain(SessionStatus.READY);
    expect(statusWrites).not.toContain(SessionStatus.READY);
  });

  it.each([
    ['the bound number links again', BOUND, BOUND],
    ['the linked number cannot be read', BOUND, ''],
    ['the session was never linked', null, STRANGER],
  ])('is announced and stored as ready when %s', async (_case, bound, linked) => {
    const { engine, stored, statusWrites, announcedStatuses } = await link(bound, linked);

    expect(engine.logout).not.toHaveBeenCalled();
    expect(stored.status).toBe(SessionStatus.READY);
    expect(announcedStatuses).toContain(SessionStatus.READY);
    expect(statusWrites).toContain(SessionStatus.READY);
  });
});
