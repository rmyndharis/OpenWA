import { FindOperator } from 'typeorm';
import { SessionEngineLifecycle, type ReconnectState } from './session-engine-lifecycle.service';
import { SessionOwnershipService } from './session-ownership.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import {
  EngineStatus,
  type AccountRestriction,
  type EngineEventCallbacks,
} from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '99999999-9999-4999-8999-999999999999';
const ME = 'node-a';
const PEER = 'node-b';

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

type OwnershipMode = 'not-owned' | 'toctou-stale-owned';

/**
 * In-memory repository honoring `{ id, nodeId }` and `[{ id, nodeId }, { id, nodeId: IsNull() }]`
 * criteria so fenced SQL updates affect 0 rows once a peer owns the row.
 */
function buildLifecycleFixture(
  opts: {
    initialNodeId?: string | null;
    initialStatus?: SessionStatus;
    initialPhone?: string | null;
    initialPushName?: string | null;
    config?: Record<string, unknown>;
  } = {},
) {
  const row: Session = {
    id: ID,
    name: 'fenced-lifecycle',
    status: opts.initialStatus ?? SessionStatus.DISCONNECTED,
    phone: opts.initialPhone ?? '628111',
    pushName: opts.initialPushName ?? 'Original Name',
    config: opts.config ?? {},
    desiredState: null,
    nodeId: opts.initialNodeId === undefined ? ME : opts.initialNodeId,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  } as Session;

  const matches = (where: unknown): boolean => {
    if (typeof where === 'string') return where === row.id;
    if (Array.isArray(where)) return where.some(matches);
    return Object.entries(where as Record<string, unknown>).every(([col, expected]) => {
      const actual = (row as unknown as Record<string, unknown>)[col];
      if (expected instanceof FindOperator) {
        return expected.type === 'isNull' ? actual == null : true;
      }
      return actual === expected;
    });
  };

  let totalAffected = 0;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...row })),
    exists: jest.fn().mockResolvedValue(true),
    update: jest.fn((where: unknown, patch: Partial<Session>) => {
      const hit = matches(where);
      if (hit) {
        totalAffected++;
        Object.assign(row, patch);
      }
      return Promise.resolve({ affected: hit ? 1 : 0 });
    }),
  };

  const owned = new Set<string>([ID]);
  const ownership = {
    nodeId: ME,
    isPostgres: false,
    owns: jest.fn((id: string) => owned.has(id)),
    prepareStart: jest.fn().mockResolvedValue(true),
    forget: jest.fn(),
    hasLiveOwnClaim: jest.fn((id: string) =>
      Promise.resolve(
        id === row.id &&
          row.nodeId === ME &&
          row.desiredState == null &&
          row.leaseExpiresAt != null &&
          row.leaseExpiresAt > new Date(),
      ),
    ),
  };

  let capturedCallbacks: EngineEventCallbacks | undefined;
  const engine = {
    initialize: jest.fn((cb: EngineEventCallbacks) => {
      capturedCallbacks = cb;
      return Promise.resolve();
    }),
    getStatus: jest.fn(() => EngineStatus.READY),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    setOnlinePresence: jest.fn().mockResolvedValue(undefined),
  };

  const factory = {
    create: jest.fn(() => engine),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };

  const events = {
    emitSessionStatus: jest.fn(),
    emitSessionAuthenticated: jest.fn(),
    emitSessionDisconnected: jest.fn(),
    emitSessionRestriction: jest.fn(),
    emitQRCode: jest.fn(),
  };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
  const audit = { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) };
  const errors = { attachTo: <T>(v: T): T => v, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  let activeRestriction: AccountRestriction | null = null;
  const restrictions = {
    attachTo: <T>(v: T): T => v,
    set: jest.fn((_id: string, restriction: AccountRestriction) => {
      activeRestriction = restriction;
      return true;
    }),
    clear: jest.fn(() => {
      const prev = activeRestriction;
      activeRestriction = null;
      return prev;
    }),
    clearIfDisprovedByReady: jest.fn().mockReturnValue(null),
  };
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn().mockReturnValue(undefined) };
  const registry = new EngineRegistry();

  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    errors as never,
    restrictions as never,
    presence as never,
    events as never,
    webhooks as never,
    hooks as never,
    {} as never,
    undefined,
    undefined,
    audit as never,
    ownership as unknown as SessionOwnershipService,
  );

  const moveRowToPeer = (mode: OwnershipMode): void => {
    row.nodeId = PEER;
    row.status = SessionStatus.READY;
    row.phone = '628999';
    row.pushName = 'Peer Account';
    if (mode === 'not-owned') {
      owned.delete(ID);
    }
    totalAffected = 0;
    repository.update.mockClear();
    events.emitSessionStatus.mockClear();
    events.emitSessionAuthenticated.mockClear();
    events.emitSessionDisconnected.mockClear();
    events.emitSessionRestriction.mockClear();
    events.emitQRCode.mockClear();
    webhooks.dispatch.mockClear();
    hooks.execute.mockClear();
    audit.logWarn.mockClear();
    audit.logInfo.mockClear();
  };

  const reconnectStates = (): Map<string, ReconnectState> =>
    (lifecycle as unknown as { reconnectStates: Map<string, ReconnectState> }).reconnectStates;

  return {
    lifecycle,
    repository,
    ownership,
    owned,
    registry,
    factory,
    engine,
    events,
    webhooks,
    hooks,
    audit,
    restrictions,
    row,
    callbacks: () => capturedCallbacks!,
    moveRowToPeer,
    totalAffected: () => totalAffected,
    reconnectStates,
  };
}

describe('SessionEngineLifecycle SQL-fenced status and metadata writes', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe.each<OwnershipMode>(['not-owned', 'toctou-stale-owned'])('when ownership has moved to a peer (%s)', mode => {
    it('handleEngineReady affects 0 rows, preserves peer row, and emits 0 webhooks/WS/hooks', async () => {
      const f = buildLifecycleFixture({ initialPhone: null, initialPushName: null });
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onReady?.('628111', 'Stale Local');
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.row.phone).toBe('628999');
      expect(f.row.pushName).toBe('Peer Account');
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
      expect(f.events.emitSessionAuthenticated).not.toHaveBeenCalled();
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.hooks.execute).not.toHaveBeenCalled();
    });

    it('handleEngineDisconnected affects 0 rows, preserves peer status/phone, emits 0 notifications, and arms no reconnect timer', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const f = buildLifecycleFixture({ config: { maxReconnectAttempts: 5, reconnectBaseDelay: 1000 } });
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      await f.lifecycle.handleEngineDisconnected(ID, f.engine as never, 'LOGOUT');
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.row.phone).toBe('628999');
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
      expect(f.events.emitSessionDisconnected).not.toHaveBeenCalled();
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.hooks.execute).not.toHaveBeenCalled();
      expect(f.reconnectStates().get(ID)?.timer ?? null).toBeNull();
    });

    it('handleEnginePushName affects 0 rows and leaves peer pushName intact', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onPushNameChanged?.('Stale Local Name');
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.pushName).toBe('Peer Account');
    });

    it('initializeEngine initial INITIALIZING write affects 0 rows and emits 0 notifications', async () => {
      const f = buildLifecycleFixture();
      f.moveRowToPeer(mode);

      await (
        f.lifecycle as unknown as { initializeEngine(id: string, session: Session): Promise<void> }
      ).initializeEngine(ID, { ...f.row });
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
    });

    it('onStateChanged affects 0 rows and emits 0 status announcements', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onStateChanged?.(EngineStatus.AUTHENTICATING);
      f.callbacks().onStateChanged?.(EngineStatus.FAILED);
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
    });

    it('onError affects 0 rows, suppresses session:error hook and status broadcast, and still evicts the local engine', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onError?.('auth failure');
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.registry.has(ID)).toBe(false);
      expect(f.engine.forceDestroy).toHaveBeenCalledTimes(1);
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
      expect(f.hooks.execute).not.toHaveBeenCalled();
    });

    it('onQRCode affects 0 rows and emits 0 QR webhooks, WS events, hooks, or status updates', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onQRCode?.('qr-payload');
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
      expect(f.events.emitQRCode).not.toHaveBeenCalled();
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.hooks.execute).not.toHaveBeenCalled();
    });

    it('onActionRequired suppresses session:error hooks', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onActionRequired?.('dismiss onboarding modal');
      await flush();

      expect(f.hooks.execute).not.toHaveBeenCalled();
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
    });

    it('onReconnecting suppresses session.reconnect_loop webhooks', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      for (let attempt = 1; attempt <= 5; attempt++) {
        f.callbacks().onReconnecting?.(attempt, 30_000);
      }
      await flush();

      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
    });

    it('onAccountRestriction suppresses restriction active and lift webhooks, WS events, and audits', async () => {
      const f = buildLifecycleFixture();
      await f.lifecycle.start(ID, { explicit: true });
      const restriction: AccountRestriction = { kind: 'reachout_timelock', code: 'TIMELOCK' };
      // Seed an existing restriction while still owned, then move ownership to peer and trigger both set and lift.
      f.restrictions.set(ID, restriction);
      f.moveRowToPeer(mode);

      f.callbacks().onAccountRestriction?.(restriction);
      f.callbacks().onAccountRestriction?.(null);
      await flush();

      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
      expect(f.events.emitSessionRestriction).not.toHaveBeenCalled();
      expect(f.audit.logWarn).not.toHaveBeenCalled();
      expect(f.audit.logInfo).not.toHaveBeenCalled();
    });

    it('exhausted scheduleReconnect FAILED write affects 0 rows and emits 0 notifications/hooks (both direct and via disconnect)', async () => {
      const f = buildLifecycleFixture({ config: { maxReconnectAttempts: 0 } });
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      // Direct call exercises scheduleReconnect exhaustion even in the TOCTOU window where ownsSession is still true.
      (f.lifecycle as unknown as { scheduleReconnect(id: string, session: Session): void }).scheduleReconnect(ID, {
        ...f.row,
        config: { maxReconnectAttempts: 0 },
      });
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.events.emitSessionDisconnected).not.toHaveBeenCalled();
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
      expect(f.hooks.execute).not.toHaveBeenCalled();
    });

    it('executeReconnect aborts before initializeEngine when ownership moved or session retired', async () => {
      const f = buildLifecycleFixture();
      const state: ReconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
      f.reconnectStates().set(ID, state);
      f.moveRowToPeer(mode);
      f.factory.create.mockClear();

      await (
        f.lifecycle as unknown as {
          executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void>;
        }
      ).executeReconnect(ID, { ...f.row }, state);
      await flush();

      expect(f.factory.create).not.toHaveBeenCalled();
      expect(f.registry.has(ID)).toBe(false);
      expect(f.reconnectStates().has(ID)).toBe(false);
      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
    });

    it('rejectRebind FAILED write affects 0 rows and emits 0 status announcements', async () => {
      const f = buildLifecycleFixture({ initialPhone: '628111' });
      await f.lifecycle.start(ID, { explicit: true });
      f.moveRowToPeer(mode);

      f.callbacks().onReady?.('628777', 'Stranger');
      await flush();

      expect(f.totalAffected()).toBe(0);
      expect(f.row.status).toBe(SessionStatus.READY);
      expect(f.row.phone).toBe('628999');
      expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
      expect(f.webhooks.dispatch).not.toHaveBeenCalled();
    });
  });

  it('logout preserves peer phone and status when ownership moves to a peer during logout teardown', async () => {
    const f = buildLifecycleFixture({ initialPhone: '628111' });
    await f.lifecycle.start(ID, { explicit: true });
    f.engine.logout.mockImplementationOnce(() => {
      f.moveRowToPeer('toctou-stale-owned');
      return Promise.resolve();
    });

    await f.lifecycle.logout(ID);

    expect(f.totalAffected()).toBe(0);
    expect(f.row.phone).toBe('628999');
    expect(f.row.status).toBe(SessionStatus.READY);
    expect(f.events.emitSessionStatus).not.toHaveBeenCalled();
    expect(f.webhooks.dispatch).not.toHaveBeenCalled();
  });

  it('still records a terminal unlink when the engine retires while handleEngineDisconnected awaits updateStatus', async () => {
    const f = buildLifecycleFixture({ initialPhone: '628111' });
    await f.lifecycle.start(ID, { explicit: true });
    f.repository.update.mockImplementationOnce((where: unknown, patch: Partial<Session>) => {
      // Simulate the engine retiring (e.g., concurrent stop) while DISCONNECTED status write is in flight,
      // while this node still owns the row and the SQL-fenced update succeeds (affected: 1).
      f.registry.deleteIfLive(ID, f.engine as never);
      expect(where).toEqual({ id: ID, nodeId: ME });
      Object.assign(f.row, patch);
      return Promise.resolve({ affected: 1 });
    });

    await f.lifecycle.handleEngineDisconnected(ID, f.engine as never, 'LOGOUT');
    await flush();

    expect(f.row.phone).toBeNull();
    expect(f.audit.logWarn).toHaveBeenCalledWith(
      AuditAction.SESSION_DISCONNECTED,
      expect.objectContaining({ sessionId: ID, metadata: { reason: 'LOGOUT' } }),
    );
    expect(f.webhooks.dispatch).toHaveBeenCalledWith(ID, 'session.disconnected', {
      sessionId: ID,
      reason: 'LOGOUT',
    });
    expect(f.events.emitSessionDisconnected).toHaveBeenCalledWith(ID, { reason: 'LOGOUT' });
  });

  it('suppresses audits, webhooks, WS events, and hooks on late evicted onDisconnected(logged out) when not owned', async () => {
    const f = buildLifecycleFixture({ initialPhone: '628111' });
    await f.lifecycle.start(ID, { explicit: true });
    // Evict engine and mark session disowned (peer now holds it).
    f.registry.deleteIfLive(ID, f.engine as never);
    f.moveRowToPeer('not-owned');

    f.callbacks().onDisconnected?.('logged out');
    await flush();

    expect(f.totalAffected()).toBe(0);
    expect(f.row.phone).toBe('628999');
    expect(f.audit.logWarn).not.toHaveBeenCalled();
    expect(f.webhooks.dispatch).not.toHaveBeenCalled();
    expect(f.events.emitSessionDisconnected).not.toHaveBeenCalled();
    expect(f.hooks.execute).not.toHaveBeenCalled();
  });

  it('persists and announces normally when this node still owns the row in the database', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const f = buildLifecycleFixture({ initialPhone: null, initialPushName: null });
    await f.lifecycle.start(ID, { explicit: true });

    f.callbacks().onReady?.('628111', 'Local Ready');
    await flush();

    expect(f.row.status).toBe(SessionStatus.READY);
    expect(f.row.phone).toBe('628111');
    expect(f.row.pushName).toBe('Local Ready');
    expect(f.events.emitSessionAuthenticated).toHaveBeenCalledWith(ID, {
      phone: '628111',
      pushName: 'Local Ready',
    });
    expect(f.webhooks.dispatch).toHaveBeenCalledWith(ID, 'session.authenticated', {
      sessionId: ID,
      phone: '628111',
      pushName: 'Local Ready',
    });
    expect(f.hooks.execute).toHaveBeenCalledWith(
      'session:ready',
      { phone: '628111', pushName: 'Local Ready' },
      expect.objectContaining({ sessionId: ID }),
    );

    f.callbacks().onPushNameChanged?.('Updated Local Name');
    await flush();
    expect(f.row.pushName).toBe('Updated Local Name');

    await f.lifecycle.handleEngineDisconnected(ID, f.engine as never, 'NAVIGATION');
    await flush();
    expect(f.row.status).toBe(SessionStatus.DISCONNECTED);
    expect(f.events.emitSessionDisconnected).toHaveBeenCalledWith(ID, { reason: 'NAVIGATION' });
    expect(f.events.emitSessionStatus).toHaveBeenCalledWith(ID, SessionStatus.DISCONNECTED);

    f.callbacks().onQRCode?.('qr-live');
    f.callbacks().onActionRequired?.('confirm on phone');
    for (let attempt = 1; attempt <= 5; attempt++) f.callbacks().onReconnecting?.(attempt, 30_000);
    f.callbacks().onAccountRestriction?.({ kind: 'reachout_timelock', code: 'TIMELOCK' });
    await flush();

    expect(f.events.emitQRCode).toHaveBeenCalledWith(ID, 'qr-live');
    expect(f.webhooks.dispatch).toHaveBeenCalledWith(ID, 'session.qr', { sessionId: ID, qr: 'qr-live' });
    expect(f.webhooks.dispatch).toHaveBeenCalledWith(ID, 'session.reconnect_loop', {
      sessionId: ID,
      attempts: 5,
      nextDelayMs: 30_000,
    });
    expect(f.events.emitSessionRestriction).toHaveBeenCalled();
    expect(f.hooks.execute).toHaveBeenCalledWith(
      'session:error',
      { reason: 'confirm on phone' },
      expect.objectContaining({ sessionId: ID }),
    );

    f.callbacks().onError?.('terminal boom');
    await flush();
    expect(f.row.status).toBe(SessionStatus.FAILED);
    expect(f.hooks.execute).toHaveBeenCalledWith(
      'session:error',
      { reason: 'terminal boom' },
      expect.objectContaining({ sessionId: ID }),
    );
  });

  it('delegates isSessionRetired to DB-clock hasLiveOwnClaim on PostgreSQL without comparing local clock', async () => {
    const f = buildLifecycleFixture();
    f.ownership.isPostgres = true;
    f.ownership.hasLiveOwnClaim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    // Simulate a row whose leaseExpiresAt looks expired on a skewed local clock: PG must trust DB clock.
    f.row.leaseExpiresAt = new Date(Date.now() - 60_000);

    const checkRetired = (): Promise<boolean> =>
      (f.lifecycle as unknown as { isSessionRetired(id: string): Promise<boolean> }).isSessionRetired(ID);

    await expect(checkRetired()).resolves.toBe(false);
    await expect(checkRetired()).resolves.toBe(true);
    expect(f.ownership.hasLiveOwnClaim).toHaveBeenCalledTimes(2);
    expect(f.ownership.hasLiveOwnClaim).toHaveBeenCalledWith(ID);
  });

  it('does not cancel a newer attempt reconnectStates entry when a superseded attempt resumes from isSessionRetired', async () => {
    const f = buildLifecycleFixture();
    const state: ReconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
    f.reconnectStates().set(ID, state);

    let releaseFirstCheck!: (retired: boolean) => void;
    const isRetiredSpy = jest.spyOn(
      f.lifecycle as unknown as { isSessionRetired(id: string): Promise<boolean> },
      'isSessionRetired',
    );
    isRetiredSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          releaseFirstCheck = resolve;
        }),
    );

    const runReconnect = (): Promise<void> =>
      (
        f.lifecycle as unknown as {
          executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void>;
        }
      ).executeReconnect(ID, { ...f.row }, state);

    // Attempt 1 enters executeReconnect and suspends on its pre-init isSessionRetired() check.
    const attempt1 = runReconnect();
    await flush();
    expect(releaseFirstCheck).toBeDefined();

    // Attempt 2 shares the same state, bumps state.started, and launches the replacement engine.
    const attempt2 = runReconnect();
    await attempt2;
    expect(f.factory.create).toHaveBeenCalledTimes(1);
    expect(f.reconnectStates().get(ID)).toBe(state);

    // Now attempt 1 resumes from its stale isSessionRetired() check: it must return silently
    // without calling cancelReconnect(ID) and wiping out attempt 2's reconnectStates entry.
    releaseFirstCheck(false);
    await attempt1;

    expect(f.factory.create).toHaveBeenCalledTimes(1);
    expect(f.reconnectStates().get(ID)).toBe(state);
    expect(f.registry.has(ID)).toBe(true);
  });
});
