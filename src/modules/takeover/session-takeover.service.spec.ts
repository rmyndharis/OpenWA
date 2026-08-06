import { ConflictException } from '@nestjs/common';
import { SessionTakeoverService } from './session-takeover.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import type { SessionService } from '../session/session.service';
import type { SessionOwnershipService } from '../session/session-ownership.service';
import type { BulkMessageService } from '../message/bulk-message.service';
import type { ConfigService } from '@nestjs/config';

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
    opts: { autoStart?: boolean; startImpl?: jest.Mock } = {},
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
      { start } as unknown as SessionService,
      { lapsedHeldByOthers: jest.fn().mockResolvedValue(rows) } as unknown as SessionOwnershipService,
      { reapProcessingBatches: reap } as unknown as BulkMessageService,
      config,
    );
    return { svc, start, reap };
  };

  afterEach(() => {
    jest.useRealTimers();
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
      { lapsedHeldByOthers: ownershipCalls } as unknown as SessionOwnershipService,
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
});
