import { ConflictException } from '@nestjs/common';
import { SessionTakeoverService } from './session-takeover.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import type { SessionService } from '../session/session.service';
import type { SessionOwnershipService } from '../session/session-ownership.service';
import type { BulkMessageService } from '../message/bulk-message.service';
import type { ConfigService } from '@nestjs/config';
import type { ShutdownService } from '../../common/services/shutdown.service';

/**
 * The sweep is the retry that boot auto-start never had: both live incidents (a container recreate
 * landing inside the old identity's lease, and a crashed peer) left sessions sitting disconnected
 * until a manual POST /start. What has to hold: only lapsed-lease sessions worth resuming are
 * started, a lost claim race is a non-event, and adopting a session reconciles its stuck batches.
 */
describe('SessionTakeoverService', () => {
  const lapsed = (over: Partial<Session> = {}): Session =>
    ({
      id: `id-${over.name ?? 'x'}`,
      name: 'x',
      status: SessionStatus.READY,
      phone: '628123',
      nodeId: 'dead-node',
      ...over,
    }) as Session;

  const build = (
    rows: Session[],
    opts: { autoStart?: boolean; startImpl?: jest.Mock; unclaimed?: Session[] } = {},
  ): { svc: SessionTakeoverService; start: jest.Mock; reap: jest.Mock } => {
    const start = opts.startImpl ?? jest.fn().mockResolvedValue({});
    const reap = jest.fn().mockResolvedValue(0);
    const config = {
      get: (key: string, def?: unknown) =>
        ({
          features: { autoStartSessions: opts.autoStart ?? true },
          'session.takeoverSweepMs': 30_000,
        })[key as 'features'] ?? def,
    } as unknown as ConfigService;
    const svc = new SessionTakeoverService(
      { start, activeEngineCount: () => 0 } as unknown as SessionService,
      {
        lapsedHeldByOthers: jest.fn().mockResolvedValue(rows),
        unclaimedRunnable: jest.fn().mockResolvedValue(opts.unclaimed ?? []),
      } as unknown as SessionOwnershipService,
      { reapProcessingBatches: reap } as unknown as BulkMessageService,
      config,
    );
    return { svc, start, reap };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  // onModuleDestroy only cleared the interval. A sweep already in flight was neither aborted nor
  // awaited, and neither sweep() nor the start path consulted any shutting-down signal — so on a
  // rolling restart an engine could be constructed and registered AFTER the shutdown path had torn
  // the registry down, and ownership.claim() could pin a session to a process that was exiting,
  // leaving it unclaimable by any peer until the lease lapsed.
  describe('a sweep racing shutdown', () => {
    it('adopts nothing once the module is being destroyed', async () => {
      const { svc, start, reap } = build([lapsed({ name: 'a' }), lapsed({ name: 'b' })]);

      svc.onModuleDestroy();
      await svc.sweep();

      expect(start).not.toHaveBeenCalled();
      expect(reap).not.toHaveBeenCalled();
    });

    it('stops adopting the rest of the batch when shutdown begins mid-sweep', async () => {
      const svcRef: { current?: { onModuleDestroy: () => void } } = {};
      const startImpl = jest.fn().mockImplementation(() => {
        svcRef.current?.onModuleDestroy(); // shutdown starts while the first adoption is in flight
        return Promise.resolve({});
      });
      const { svc, start } = build([lapsed({ name: 'a' }), lapsed({ name: 'b' }), lapsed({ name: 'c' })], {
        startImpl,
      });
      svcRef.current = svc;

      await svc.sweep();

      expect(start).toHaveBeenCalledTimes(1);
    });

    // Negative twin: an ordinary sweep must still adopt everything eligible.
    it('still adopts the whole batch when no shutdown is in progress', async () => {
      const { svc, start } = build([lapsed({ name: 'a' }), lapsed({ name: 'b' })]);

      await svc.sweep();

      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  it('adopts a lapsed authenticated session and reconciles its stuck batches', async () => {
    const { svc, start, reap } = build([lapsed({ name: 'a' })]);

    await svc.sweep();

    expect(start).toHaveBeenCalledWith('id-a');
    expect(reap).toHaveBeenCalledWith('id-a', expect.stringContaining('lapsed'));
  });

  it('skips sessions not worth resuming: unauthenticated, mid-pairing, or operator-flagged failed', async () => {
    const { svc, start } = build([
      lapsed({ name: 'no-phone', phone: undefined as unknown as string }),
      lapsed({ name: 'pairing', status: SessionStatus.QR_READY }),
      lapsed({ name: 'failed', status: SessionStatus.FAILED }),
    ]);

    await svc.sweep();

    expect(start).not.toHaveBeenCalled();
  });

  it('a lost claim race is a non-event: no batch reconcile, and the next candidate still starts', async () => {
    jest.useFakeTimers();
    const start = jest.fn().mockRejectedValueOnce(new ConflictException('held elsewhere')).mockResolvedValueOnce({});
    const { svc, reap } = build([lapsed({ name: 'raced' }), lapsed({ name: 'ours' })], { startImpl: start });

    const sweep = svc.sweep();
    await jest.advanceTimersByTimeAsync(2100); // the inter-launch stagger
    await sweep;

    expect(start).toHaveBeenCalledTimes(2);
    expect(reap).toHaveBeenCalledTimes(1);
    expect(reap).toHaveBeenCalledWith('id-ours', expect.any(String));
  });

  it('a non-conflict start failure is logged and does not abort the rest of the sweep', async () => {
    jest.useFakeTimers();
    const start = jest.fn().mockRejectedValueOnce(new Error('chromium died')).mockResolvedValueOnce({});
    const { svc } = build([lapsed({ name: 'boom' }), lapsed({ name: 'fine' })], { startImpl: start });

    const sweep = svc.sweep();
    await jest.advanceTimersByTimeAsync(2100);
    await expect(sweep).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('the AUTO_START_SESSIONS opt-out disables the sweep timer entirely', () => {
    jest.useFakeTimers();
    const { svc } = build([], { autoStart: false });

    svc.onApplicationBootstrap();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('arms the timer when auto-start is on, and tears it down on destroy', () => {
    jest.useFakeTimers();
    const { svc } = build([]);

    svc.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);

    svc.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never stacks sweeps: a tick that fires while one is in flight is skipped', async () => {
    jest.useFakeTimers();
    let resolveFirst: () => void = () => undefined;
    const start = jest.fn().mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveFirst = resolve;
        }),
    );
    const ownershipCalls = jest.fn().mockResolvedValue([lapsed({ name: 'slow' })]);
    const config = {
      get: (key: string, def?: unknown) =>
        ({ features: { autoStartSessions: true }, 'session.takeoverSweepMs': 1000 })[key as 'features'] ?? def,
    } as unknown as ConfigService;
    const svc = new SessionTakeoverService(
      { start } as unknown as SessionService,
      {
        lapsedHeldByOthers: ownershipCalls,
        unclaimedRunnable: jest.fn().mockResolvedValue([]),
      } as unknown as SessionOwnershipService,
      { reapProcessingBatches: jest.fn().mockResolvedValue(0) } as unknown as BulkMessageService,
      config,
    );

    svc.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1000); // tick 1: sweep starts, hangs in start()
    await jest.advanceTimersByTimeAsync(2000); // ticks 2-3 fire while it is in flight

    expect(ownershipCalls).toHaveBeenCalledTimes(1);

    resolveFirst();
    svc.onModuleDestroy();
  });

  /**
   * There are TWO shutdown guards: one at sweep entry and one per adoption. Every existing case has
   * at least one eligible session, so the per-adoption guard stops the work either way and the entry
   * guard binds nothing — deleting it left the whole suite green.
   *
   * The ownership QUERY is what separates them: it runs before the per-adoption guard, so a sweep
   * that never queries proves the entry guard fired. That also matters on its own — a sweep entered
   * during shutdown otherwise still hits the database on every remaining tick.
   */
  /**
   * `onModuleDestroy` runs at `app.close()` — AFTER the bounded drain. On SIGTERM main.ts flips
   * readiness to 503 and waits SHUTDOWN_DELAY_MS first, and throughout that window the sweep timer is
   * still armed while the local flag is still false: a tick can launch Chromium and claim an
   * ownership lease for a process that is about to exit, which is the rolling-restart case this
   * guard exists for. Two siblings in this repo already consult ShutdownService for exactly that —
   * session-engine-lifecycle and the liveness watchdog.
   */
  it('does not adopt during the drain window, before onModuleDestroy runs', async () => {
    const ownershipCalls = jest.fn().mockResolvedValue([lapsed({ name: 'any' })]);
    const start = jest.fn().mockResolvedValue(undefined);
    const config = {
      get: (key: string, def?: unknown) =>
        ({ features: { autoStartSessions: true }, 'session.takeoverSweepMs': 1000 })[key as 'features'] ?? def,
    } as unknown as ConfigService;
    const svc = new SessionTakeoverService(
      { start } as unknown as SessionService,
      {
        lapsedHeldByOthers: ownershipCalls,
        unclaimedRunnable: jest.fn().mockResolvedValue([]),
      } as unknown as SessionOwnershipService,
      { reapProcessingBatches: jest.fn().mockResolvedValue(0) } as unknown as BulkMessageService,
      config,
      { isShuttingDown: () => true } as unknown as ShutdownService,
    );

    // Deliberately NOT calling onModuleDestroy: this is the drain window, where the signal has
    // arrived but Nest has not torn the module down yet.
    await svc.sweep();

    expect(ownershipCalls).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('a sweep entered during shutdown does not even query ownership', async () => {
    const ownershipCalls = jest.fn().mockResolvedValue([lapsed({ name: 'any' })]);
    const config = {
      get: (key: string, def?: unknown) =>
        ({ features: { autoStartSessions: true }, 'session.takeoverSweepMs': 1000 })[key as 'features'] ?? def,
    } as unknown as ConfigService;
    const svc = new SessionTakeoverService(
      { start: jest.fn().mockResolvedValue(undefined) } as unknown as SessionService,
      {
        lapsedHeldByOthers: ownershipCalls,
        unclaimedRunnable: jest.fn().mockResolvedValue([]),
      } as unknown as SessionOwnershipService,
      { reapProcessingBatches: jest.fn().mockResolvedValue(0) } as unknown as BulkMessageService,
      config,
    );

    svc.onModuleDestroy(); // flips the shutting-down signal
    await svc.sweep();

    expect(ownershipCalls).not.toHaveBeenCalled();
  });

  describe('desired-state reconciliation', () => {
    it('adopts a runnable session nobody holds — not only lapsed ones', async () => {
      const orphan = lapsed({ name: 'orphan', nodeId: null, status: SessionStatus.DISCONNECTED });
      const { svc, start } = build([], { unclaimed: [orphan] });

      await svc.sweep();

      expect(start).toHaveBeenCalledWith(orphan.id);
    });

    it('never resurrects a session whose desiredState is stopped', async () => {
      const stopped = lapsed({ name: 'stopped-on-purpose', desiredState: 'stopped' });
      const running = lapsed({ name: 'wants-to-run', desiredState: 'running' });
      const { svc, start } = build([stopped, running]);

      await svc.sweep();

      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(running.id);
    });

    it('does not adopt the same session twice when both feeds return it', async () => {
      const twice = lapsed({ name: 'dup' });
      const { svc, start } = build([twice], { unclaimed: [twice] });

      await svc.sweep();

      expect(start).toHaveBeenCalledTimes(1);
    });
  });
});
