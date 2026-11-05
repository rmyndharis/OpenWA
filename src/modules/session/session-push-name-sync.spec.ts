import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import type { EngineEventCallbacks, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { PhoneWrites } from './session-phone-writes';

const ID = '88888888-8888-4888-8888-888888888888';
const PHONE = '628111';

/** Lets the writes that wait behind an earlier one reach the repository. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

/**
 * A newly linked Baileys account's ready event carries an empty push name: WhatsApp syncs the name only
 * after the connection opened. The engine reports it then, and the session row stores it without the
 * session being announced as authenticated a second time.
 */
function fixture() {
  const stored = {
    id: ID,
    name: 'push-name-sync',
    phone: null,
    pushName: null,
    config: {},
    status: SessionStatus.DISCONNECTED,
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
  const engines: Array<{ initialize: jest.Mock }> = [];
  const factory = {
    create: jest.fn(() => {
      const engine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        setOnlinePresence: jest.fn().mockResolvedValue(undefined),
      };
      engines.push(engine);
      return engine;
    }),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const restrictions = { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() };
  const events = { emitSessionStatus: jest.fn(), emitSessionAuthenticated: jest.fn(), emitQRCode: jest.fn() };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
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
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    events as never,
    webhooks as never,
    hooks as never,
    {} as never,
  );
  const callbacks = (): EngineEventCallbacks => (engines[0].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  // The ready event writes its number and push name together, apart from its status: only a write of the name alone counts.
  const pushNameWrites = (): number =>
    repository.update.mock.calls.filter(
      ([, patch]) => 'pushName' in patch && !('status' in patch) && !('phone' in patch),
    ).length;
  const authenticatedWebhooks = (): number =>
    webhooks.dispatch.mock.calls.filter(([, event]) => event === 'session.authenticated').length;
  return { lifecycle, registry, repository, stored, events, hooks, callbacks, pushNameWrites, authenticatedWebhooks };
}

describe('the push name an engine syncs after its ready event', () => {
  it('is stored on the session row, and the session is not announced again', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.callbacks().onReady?.(PHONE, '');
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.stored.pushName).toBe('');

    f.callbacks().onPushNameChanged?.('Synced Later');
    await settle();

    expect(f.stored.pushName).toBe('Synced Later');
    expect(f.stored.phone).toBe(PHONE);
    expect(f.authenticatedWebhooks()).toBe(1);
    expect(f.events.emitSessionAuthenticated).toHaveBeenCalledTimes(1);
    expect(f.hooks.execute.mock.calls.filter(([hook]) => hook === 'session:ready')).toHaveLength(1);
  });

  it.each([
    ['is empty', () => undefined, ''],
    [
      'comes from an engine that is no longer the live one',
      (f: ReturnType<typeof fixture>) => {
        f.registry.set(ID, {} as IWhatsAppEngine);
      },
      'Late Name',
    ],
    [
      'reaches a node that no longer owns the session',
      (f: ReturnType<typeof fixture>) => {
        (f.lifecycle as unknown as { ownership: { owns: () => boolean } }).ownership = { owns: () => false };
      },
      'Late Name',
    ],
  ])('is not stored when it %s', async (_case, arrange, name) => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.callbacks().onReady?.(PHONE, 'At Ready');
    arrange(f);

    f.callbacks().onPushNameChanged?.(name);
    await settle();

    expect(f.pushNameWrites()).toBe(0);
    expect(f.stored.pushName).toBe('At Ready');
  });

  // The number and name of the ready event wait behind a write issued earlier for the session (an unlink's clear whose answer
  // is late); the name that arrives meanwhile has to land after them, or the empty one of the ready event replaces it.
  it('is stored after the row of the ready event, when that row waits for an earlier write', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    let answer!: () => void;
    const earlier = new Promise<void>(resolve => (answer = resolve));
    void (f.lifecycle as unknown as { phoneWrites: PhoneWrites }).phoneWrites.run(ID, () => earlier);

    f.callbacks().onReady?.(PHONE, '');
    f.callbacks().onPushNameChanged?.('Synced Later');
    expect(f.stored.phone).toBeNull(); // the number waits for the earlier write
    answer();
    await settle();

    expect({ phone: f.stored.phone, pushName: f.stored.pushName }).toEqual({ phone: PHONE, pushName: 'Synced Later' });
  });

  it('is logged, not thrown, when the row cannot be written', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.callbacks().onReady?.(PHONE, '');
    const warn = jest.spyOn((f.lifecycle as unknown as { logger: { warn: () => void } }).logger, 'warn');
    f.repository.update.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    expect(() => f.callbacks().onPushNameChanged?.('Synced Later')).not.toThrow();

    const deadline = Date.now() + 2_000;
    while (!warn.mock.calls.length && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(
      'Failed to store the synced push name',
      expect.objectContaining({ sessionId: ID, action: 'push_name_store_failed' }),
    );
  });
});
