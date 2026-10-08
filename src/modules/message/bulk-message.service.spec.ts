import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LoggerService } from '../../common/services/logger.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import {
  BulkMessageService,
  resolveFinalBatchStatus,
  sanitizeBatchError,
  resolveMaxConcurrentBatches,
} from './bulk-message.service';
import { MessageBatch, BatchStatus, BatchMessageStatus, BatchMessageResult } from './entities/message-batch.entity';
import { MessageStatus } from './entities/message.entity';
import { SendBulkMessageDto } from './dto/bulk-message.dto';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { MessageService } from './message.service';
import { SendPacingService, SEND_PACING_LIMITED } from './send-pacing.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { HookManager } from '../../core/hooks';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { EnginePageError } from '../../common/errors/engine-page.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/** Regression lock for the terminal-status decision (cancel-clobber + stopOnError overwrite bugs). */
describe('resolveFinalBatchStatus', () => {
  it('CANCELLED wins even when messages were sent/failed (no clobber back to PROCESSING/COMPLETED)', () => {
    expect(resolveFinalBatchStatus(true, false, { sent: 3, failed: 1 })).toBe(BatchStatus.CANCELLED);
  });

  it('cancellation takes precedence over stop-on-error', () => {
    expect(resolveFinalBatchStatus(true, true, { sent: 0, failed: 1 })).toBe(BatchStatus.CANCELLED);
  });

  it('stopOnError → FAILED even when some messages already sent (not COMPLETED)', () => {
    expect(resolveFinalBatchStatus(false, true, { sent: 5, failed: 1 })).toBe(BatchStatus.FAILED);
  });

  it('all attempts failed → FAILED', () => {
    expect(resolveFinalBatchStatus(false, false, { sent: 0, failed: 4 })).toBe(BatchStatus.FAILED);
  });

  it('some sent (with or without failures) → COMPLETED', () => {
    expect(resolveFinalBatchStatus(false, false, { sent: 4, failed: 0 })).toBe(BatchStatus.COMPLETED);
    expect(resolveFinalBatchStatus(false, false, { sent: 3, failed: 1 })).toBe(BatchStatus.COMPLETED);
  });
});

describe('resolveMaxConcurrentBatches', () => {
  const prev = process.env.BULK_MAX_CONCURRENT_BATCHES;
  afterEach(() => {
    if (prev === undefined) delete process.env.BULK_MAX_CONCURRENT_BATCHES;
    else process.env.BULK_MAX_CONCURRENT_BATCHES = prev;
  });

  it('treats a blank BULK_MAX_CONCURRENT_BATCHES as unset, not as 0 (unlimited)', () => {
    process.env.BULK_MAX_CONCURRENT_BATCHES = '';
    expect(resolveMaxConcurrentBatches()).toBe(50);
  });
});

/** Regression lock: orphaned (restart-interrupted) PROCESSING batches are transitioned. */
describe('BulkMessageService.onApplicationBootstrap', () => {
  let service: BulkMessageService;
  let repo: { find: jest.Mock; save: jest.Mock; update: jest.Mock };
  const failedWrite = (id: string): [object, unknown] => [
    { id, status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
    expect.objectContaining({ status: BatchStatus.FAILED }) as unknown,
  ];

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        EngineRegistry,
        { provide: MessageService, useValue: { saveOutgoingMessage: jest.fn() } },
        {
          // Pacing is off by default; its own spec covers the governor. Here it must simply not
          // refuse, so the bulk assertions exercise the paths they were written for.
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        {
          provide: HookManager,
          useValue: {
            execute: jest
              .fn()
              .mockImplementation((_e: string, d: unknown) => Promise.resolve({ continue: true, data: d })),
          },
        },
      ],
    }).compile();
    service = module.get<BulkMessageService>(BulkMessageService);
  });

  it('marks an orphaned PROCESSING batch FAILED on startup (no auto-resume)', async () => {
    const batch = { id: 'b1', status: BatchStatus.PROCESSING } as unknown as MessageBatch;
    repo.find.mockResolvedValue([batch]);

    await service.onApplicationBootstrap();

    expect(repo.find).toHaveBeenCalledWith({
      where: { status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
    });
    expect(repo.update).toHaveBeenCalledWith(...failedWrite('b1'));
    expect(repo.save).not.toHaveBeenCalled();
  });

  // The process died between persisting the batch and its start transition. No run exists at boot,
  // so the row would otherwise stay PENDING forever: no reaper or retention sweep ever selects it.
  it('marks a PENDING batch a previous process never started FAILED on startup', async () => {
    repo.find.mockResolvedValue([{ id: 'b-new', status: BatchStatus.PENDING, messages: [] }]);

    await service.onApplicationBootstrap();

    expect(repo.update).toHaveBeenCalledWith(...failedWrite('b-new'));
  });

  // FAILED is terminal, and the status route documents completedAt as null only while a batch runs.
  it('stamps completedAt on a batch it fails, like every other terminal write', async () => {
    repo.find.mockResolvedValue([{ id: 'b1', status: BatchStatus.PROCESSING, messages: [] }]);

    await service.onApplicationBootstrap();

    const written = (repo.update.mock.calls[0] as [unknown, Partial<MessageBatch>])[1];
    expect(written.completedAt).toBeInstanceOf(Date);
  });

  it('does nothing when there are no orphaned batches', async () => {
    repo.find.mockResolvedValue([]);
    await service.onApplicationBootstrap();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('counts on startup only the batches the guarded update actually failed', async () => {
    const stale = { id: 'b-done', status: BatchStatus.PROCESSING, messages: [] };
    const orphan = { id: 'b-dead', status: BatchStatus.PROCESSING, messages: [] };
    repo.find.mockResolvedValue([stale, orphan]);
    repo.update.mockImplementation((where: { id: string }) =>
      Promise.resolve({ affected: where.id === 'b-dead' ? 1 : 0 }),
    );
    const warn = jest.spyOn((service as unknown as { logger: LoggerService }).logger, 'warn').mockImplementation();

    await service.onApplicationBootstrap();

    expect(repo.update).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Marked 1 orphaned unfinished batch(es) FAILED on startup (interrupted by a restart)',
    );
  });

  /**
   * The takeover path's reconcile: adopting a session from a lapsed node must fail THAT session's
   * stuck batches (same no-auto-resume policy as boot — the dead node's already-sent messages are
   * unknowable), scoped strictly to the one session, with inline media payloads stripped.
   */
  it('reapProcessingBatches fails only the given session’s unfinished batches and strips payloads', async () => {
    const mine = {
      id: 'b1',
      sessionId: 'sess-a',
      status: BatchStatus.PROCESSING,
      messages: [{ content: { image: { base64: 'x'.repeat(64) } } }],
    } as unknown as MessageBatch;
    repo.find.mockResolvedValue([mine]);

    const reaped = await service.reapProcessingBatches('sess-a', 'session adopted from a lapsed node');

    expect(repo.find).toHaveBeenCalledWith({
      where: { status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]), sessionId: 'sess-a' },
    });
    expect(reaped).toBe(1);
    expect(repo.update).toHaveBeenCalledWith(...failedWrite('b1'));
    const written = (repo.update.mock.calls[0] as [unknown, Partial<MessageBatch>])[1];
    expect(JSON.stringify(written.messages)).not.toContain('x'.repeat(64));
  });

  // The row was read as PROCESSING, but a batch can finalize before the write lands. The guard in the
  // UPDATE matches nothing then, and the reap must neither count it nor touch its terminal state.
  it('reapProcessingBatches does not count a batch that completed after it was read', async () => {
    const stale = { id: 'b-done', sessionId: 'sess-a', status: BatchStatus.PROCESSING, messages: [] };
    const orphan = { id: 'b-dead', sessionId: 'sess-a', status: BatchStatus.PROCESSING, messages: [] };
    repo.find.mockResolvedValue([stale, orphan]);
    repo.update.mockImplementation((where: { id: string }) =>
      Promise.resolve({ affected: where.id === 'b-dead' ? 1 : 0 }),
    );

    const reaped = await service.reapProcessingBatches('sess-a', 'session adopted from a lapsed node');

    expect(reaped).toBe(1);
    expect(repo.update).toHaveBeenCalledWith(...failedWrite('b-done'));
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('reapProcessingBatches leaves alone a PROCESSING batch this process is still running', async () => {
    // A batch this process still runs for the session, from an earlier stint as its holder or a
    // stale engine, is not the lapsed holder's to fail.
    const running = { id: 'b-live', sessionId: 'sess-a', status: BatchStatus.PROCESSING, messages: [] };
    const orphan = { id: 'b-dead', sessionId: 'sess-a', status: BatchStatus.PROCESSING, messages: [] };
    repo.find.mockResolvedValue([running, orphan]);
    (service as unknown as { processingBatches: Map<string, boolean> }).processingBatches.set('b-live', true);

    const reaped = await service.reapProcessingBatches('sess-a', 'session adopted from a lapsed node');

    expect(reaped).toBe(1);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(...failedWrite('b-dead'));
  });

  // An explicit start or stop takes a session over from a lapsed node as much as the takeover sweep
  // does, so the reap is handed to the ownership service all of them go through.
  it('hands the lapsed-holder reap to the ownership service', async () => {
    const onAdoption = jest.fn<void, [(sessionId: string) => Promise<unknown>]>();
    const svc = new BulkMessageService(
      repo as never,
      new EngineRegistry(),
      {} as never,
      {} as never,
      {} as never,
      { onAdoption } as never,
    );
    svc.onModuleInit();
    repo.find.mockResolvedValue([{ id: 'b-dead', sessionId: 'sess-a', status: BatchStatus.PENDING, messages: [] }]);

    await onAdoption.mock.calls[0][0]('sess-a');

    expect(repo.find).toHaveBeenCalledWith({
      where: { status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]), sessionId: 'sess-a' },
    });
    expect(repo.update).toHaveBeenCalledWith(...failedWrite('b-dead'));
  });

  /**
   * A batch is only ever driven by the process holding its session's engine, so on a second replica
   * "PROCESSING" does not mean "abandoned". Reaping a peer's batch tells the caller their send
   * failed while the messages continue going out — a wrong answer about work that is still running.
   */
  describe('with another node in play', () => {
    /** Rebuild the service with an ownership service that owns only `ownedSessionIds`. */
    const withOwnership = async (ownedSessionIds: string[]): Promise<BulkMessageService> => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BulkMessageService,
          { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
          EngineRegistry,
          { provide: MessageService, useValue: { saveOutgoingMessage: jest.fn() } },
          {
            provide: SendPacingService,
            useValue: {
              assertSendAllowed: jest.fn().mockResolvedValue(undefined),
              recordSendFailure: jest.fn(),
              recordSendSuccess: jest.fn(),
            },
          },
          {
            provide: HookManager,
            useValue: {
              execute: jest
                .fn()
                .mockImplementation((_e: string, d: unknown) => Promise.resolve({ continue: true, data: d })),
            },
          },
          {
            provide: SessionOwnershipService,
            useValue: {
              claimable: jest.fn((ids: string[]) => Promise.resolve(ids.filter(id => ownedSessionIds.includes(id)))),
            },
          },
        ],
      }).compile();
      return module.get<BulkMessageService>(BulkMessageService);
    };

    it('leaves a batch alone when its session belongs to another node', async () => {
      const peers = { id: 'b1', sessionId: 'peer-session', status: BatchStatus.PROCESSING } as MessageBatch;
      repo.find.mockResolvedValue([peers]);

      await (await withOwnership([])).onApplicationBootstrap();

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('still reaps a batch whose session this node may claim', async () => {
      const mine = { id: 'b2', sessionId: 'my-session', status: BatchStatus.PROCESSING } as MessageBatch;
      repo.find.mockResolvedValue([mine]);

      await (await withOwnership(['my-session'])).onApplicationBootstrap();

      expect(repo.update).toHaveBeenCalledWith(...failedWrite('b2'));
    });

    it('reaps only its own when both are present', async () => {
      const mine = { id: 'b2', sessionId: 'my-session', status: BatchStatus.PROCESSING } as MessageBatch;
      const peers = { id: 'b1', sessionId: 'peer-session', status: BatchStatus.PROCESSING } as MessageBatch;
      repo.find.mockResolvedValue([mine, peers]);

      await (await withOwnership(['my-session'])).onApplicationBootstrap();

      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(...failedWrite('b2'));
    });
  });
});

/** Regression lock: an SSRF block (which names the internal host/IP) must not be stored verbatim. */
describe('sanitizeBatchError', () => {
  it('replaces an SSRF block message with a generic one (no internal address leak)', () => {
    const result = sanitizeBatchError(
      new SsrfBlockedError('Host evil.example resolves to a blocked internal address: 169.254.169.254'),
    );
    expect(result.message).not.toContain('169.254.169.254');
    expect(result.code).toBe('SEND_BLOCKED');
  });

  it('passes through an ordinary error message under SEND_FAILED', () => {
    const result = sanitizeBatchError(new Error('Session is not active'));
    expect(result).toEqual({ code: 'SEND_FAILED', message: 'Session is not active' });
  });

  it('keeps the pacing code, so a policy 429 is distinguishable from an engine refusal', () => {
    const refusal = new HttpException(
      { statusCode: 429, message: 'Daily send allowance of 20 reached', code: 'SEND_PACING_LIMITED' },
      429,
    );
    const result = sanitizeBatchError(refusal);
    expect(result).toEqual({ code: 'SEND_PACING_LIMITED', message: 'Daily send allowance of 20 reached' });
  });
});

describe('BulkMessageService.processBatch', () => {
  let service: BulkMessageService;
  let repo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let messageService: { saveOutgoingMessage: jest.Mock };
  let engine: {
    sendTextMessage: jest.Mock;
    sendImageMessage?: jest.Mock;
    sendVideoMessage?: jest.Mock;
    sendAudioMessage?: jest.Mock;
  };
  let engines: EngineRegistry;
  let hookManager: { execute: jest.Mock };
  let pacing: { assertSendAllowed: jest.Mock; recordSendFailure: jest.Mock; recordSendSuccess: jest.Mock };

  const makeBatch = (messageCount: number): MessageBatch =>
    ({
      id: 'b1',
      batchId: 'bx',
      sessionId: 's1',
      status: BatchStatus.PENDING,
      currentIndex: 0,
      messages: Array.from({ length: messageCount }, (_, i) => ({
        chatId: `c${i}@c.us`,
        type: 'text',
        content: { text: 'hi' },
      })),
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: messageCount, sent: 0, failed: 0, pending: messageCount, cancelled: 0 },
      results: [],
    }) as unknown as MessageBatch;

  beforeEach(async () => {
    engine = {
      sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa1', timestamp: 111 }),
      sendImageMessage: jest.fn().mockResolvedValue({ id: 'wa1', timestamp: 111 }),
      sendAudioMessage: jest.fn().mockResolvedValue({ id: 'wa1', timestamp: 111 }),
    };
    engines = new EngineRegistry();
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    messageService = { saveOutgoingMessage: jest.fn().mockResolvedValue(undefined) };
    hookManager = {
      execute: jest.fn().mockImplementation((_e: string, data: unknown) => Promise.resolve({ continue: true, data })),
    };
    pacing = {
      assertSendAllowed: jest.fn().mockResolvedValue(undefined),
      recordSendFailure: jest.fn(),
      recordSendSuccess: jest.fn(),
    };
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
      // Guarded status writes: default to "the row matched" (1 affected), as when no cancel committed.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        { provide: EngineRegistry, useValue: engines },
        { provide: MessageService, useValue: messageService },
        {
          provide: SendPacingService,
          useValue: pacing,
        },
        { provide: HookManager, useValue: hookManager },
      ],
    }).compile();
    service = module.get<BulkMessageService>(BulkMessageService);
  });

  const runProcessBatch = (): Promise<void> =>
    (service as unknown as { processBatch: (id: string) => Promise<void> }).processBatch('b1');

  const inFlightMarkers = (): Map<string, boolean> =>
    (service as unknown as { processingBatches: Map<string, boolean> }).processingBatches;

  // A run that throws would otherwise leave the row PENDING or PROCESSING with nothing left to move
  // it on while this process lives: the reapers only run at boot and on a session takeover.
  it.each([
    ['the pickup read', () => repo.findOne.mockRejectedValueOnce(new Error('database unavailable'))],
    [
      'the start transition',
      () => {
        repo.findOne.mockResolvedValue(makeBatch(1));
        repo.update.mockRejectedValueOnce(new Error('database unavailable'));
      },
    ],
  ])('fails the batch when %s throws, and rethrows', async (_label, arrange) => {
    arrange();

    await expect(runProcessBatch()).rejects.toThrow('database unavailable');

    expect(repo.update).toHaveBeenLastCalledWith(
      { id: 'b1', status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
      expect.objectContaining({ status: BatchStatus.FAILED, completedAt: expect.any(Date) as unknown }),
    );
    expect(inFlightMarkers().has('b1')).toBe(false);
  });

  // Only this run knows what it sent: a FAILED written without that would report delivered items as
  // pending, and a re-issue of the unsent items would send them again.
  it('records what the run sent when a progress write throws after a send', async () => {
    repo.findOne.mockResolvedValue(makeBatch(3));
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockRejectedValueOnce(new Error('database unavailable')); // progress write after item 0 was sent

    await expect(runProcessBatch()).rejects.toThrow('database unavailable');

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    const [criteria, partial] = (repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>).at(-1)!;
    expect(criteria).toEqual({ id: 'b1', status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) });
    expect(partial.status).toBe(BatchStatus.FAILED);
    expect(partial.results?.[0].status).toBe(BatchMessageStatus.SENT);
    expect(partial.progress).toMatchObject({ sent: 1, pending: 2 });
    expect(partial.currentIndex).toBe(1);
  });

  // Shutdown releases this node's sessions, and the node that starts one next does not adopt it from
  // a lapsed lease, so it never reaps a batch left PROCESSING here.
  it('fails a running batch on shutdown, and the run records what it sent under that FAILED', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(3)) // pickup
      .mockResolvedValueOnce(makeBatch(3)) // the shutdown read
      .mockResolvedValueOnce({ status: BatchStatus.FAILED }); // re-read after the progress write missed
    inFlightMarkers().set('b1', true);
    engine.sendTextMessage.mockImplementationOnce(async () => {
      await service.onModuleDestroy(); // the process shuts down while the first send is in flight
      return { id: 'wa1', timestamp: 111 };
    });
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockResolvedValueOnce({ affected: 1 }) // the shutdown write: PROCESSING -> FAILED
      .mockResolvedValueOnce({ affected: 0 }); // progress write at i=0: the row is FAILED now

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    const calls = repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>;
    expect(calls[1]).toEqual([
      { id: 'b1', status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
      expect.objectContaining({ status: BatchStatus.FAILED }),
    ]);
    const [criteria, partial] = calls.at(-1)!;
    expect(criteria).toEqual({ id: 'b1', status: BatchStatus.FAILED });
    expect(partial.status).toBeUndefined();
    expect(partial.results).toHaveLength(1);
  });

  it('strips the stored media payloads when it fails a batch on shutdown', async () => {
    const batch = makeBatch(1);
    batch.messages = [
      { chatId: 'c0@c.us', type: 'image', content: { image: { base64: 'QkFTRTY0', mimetype: 'image/png' } } },
    ];
    repo.findOne.mockResolvedValueOnce(batch);
    inFlightMarkers().set('b1', true);
    repo.update.mockResolvedValueOnce({ affected: 1 });

    await service.onModuleDestroy();

    const [, partial] = (repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>)[0];
    expect(partial.status).toBe(BatchStatus.FAILED);
    const img = (partial.messages![0].content as { image?: { base64?: unknown; mimetype?: string } }).image;
    expect(img?.base64).toBeUndefined();
    expect(img?.mimetype).toBe('image/png');
    expect(inFlightMarkers().get('b1')).toBe(false);
  });

  it('leaves a batch alone on shutdown when it already ended', async () => {
    inFlightMarkers().set('b1', true);
    repo.update.mockResolvedValueOnce({ affected: 0 }); // the batch finished before the shutdown write

    await service.onModuleDestroy();

    expect(inFlightMarkers().get('b1')).toBe(true);
  });

  it('still rethrows the run error when failing the batch throws too', async () => {
    repo.findOne.mockRejectedValueOnce(new Error('database unavailable'));
    repo.update.mockRejectedValueOnce(new Error('still unavailable'));

    await expect(runProcessBatch()).rejects.toThrow('database unavailable');
  });

  // A reap after this process takes a session over from a lapsed node also fails PENDING batches, so a
  // batch this process creates must be registered before any reap can read its row.
  it('registers a new batch before its row is written, so a reap leaves it alone', async () => {
    repo.findOne.mockResolvedValueOnce(null).mockReturnValueOnce(new Promise(() => undefined));
    Object.assign(repo, { create: jest.fn((b: Partial<MessageBatch>) => ({ ...b })) });
    let registeredAtWrite: boolean | undefined;
    repo.save.mockImplementation((b: MessageBatch) => {
      registeredAtWrite = inFlightMarkers().get(b.id);
      return Promise.resolve(b);
    });
    const created = await service.createBatch('s1', {
      messages: [{ chatId: 'c@c.us', type: 'text', content: { text: 'hi' } }],
    } as never);
    Object.assign(repo, { find: jest.fn().mockResolvedValue([{ ...created, status: BatchStatus.PENDING }]) });

    expect(registeredAtWrite).toBe(true);
    expect(await service.reapProcessingBatches('s1', 'session taken from a lapsed node')).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('keeps the cancel signal of a cancel that lands while the new batch is being saved', async () => {
    repo.findOne.mockResolvedValueOnce(null).mockReturnValueOnce(new Promise(() => undefined));
    Object.assign(repo, { create: jest.fn((b: Partial<MessageBatch>) => ({ ...b })) });
    repo.save.mockImplementation((b: MessageBatch) => {
      inFlightMarkers().set(b.id, false); // cancelBatch found the committed row first
      return Promise.resolve(b);
    });
    const created = await service.createBatch('s1', {
      messages: [{ chatId: 'c@c.us', type: 'text', content: { text: 'hi' } }],
    } as never);

    expect(inFlightMarkers().get(created.id)).toBe(false);
  });

  // The shutdown fail reads each registered batch's row, and a row still being written is not there
  // yet: its guarded write matches nothing. The batch must not start sending once that write lands.
  it('fails a batch whose row was still being written when shutdown began, and sends nothing', async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => (releaseSave = resolve));
    Object.assign(repo, { create: jest.fn((b: Partial<MessageBatch>) => ({ ...b })) });
    repo.save.mockImplementation(async (b: MessageBatch) => {
      await saveGate;
      return b;
    });
    const pickup = jest.spyOn(service as unknown as { processBatch: () => Promise<void> }, 'processBatch');
    const created = service.createBatch('s1', {
      messages: [
        { chatId: 'c0@c.us', type: 'text', content: { text: 'a' } },
        { chatId: 'c1@c.us', type: 'text', content: { text: 'b' } },
      ],
      options: { delayBetweenMessages: 0, randomizeDelay: false },
    } as never);
    await new Promise(resolve => setImmediate(resolve)); // createBatch is parked in save
    expect(repo.save).toHaveBeenCalledTimes(1);

    repo.findOne.mockResolvedValueOnce(null); // the shutdown read: the row is not there yet
    repo.update.mockResolvedValueOnce({ affected: 0 });
    await service.onModuleDestroy();

    repo.findOne.mockImplementationOnce(({ where }: { where: { id: string } }) =>
      Promise.resolve({ ...makeBatch(2), id: where.id }),
    ); // the pickup reads the committed PENDING row
    releaseSave();
    const batch = await created;
    await pickup.mock.results[0].value;

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenLastCalledWith(
      { id: batch.id, status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
      expect.objectContaining({ status: BatchStatus.FAILED }),
    );
    expect(repo.update).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: BatchStatus.PROCESSING }),
    );
    expect(inFlightMarkers().size).toBe(0);
    expect((service as unknown as { inFlightBatches: number }).inFlightBatches).toBe(0);
  });

  it('refuses a new batch once shutdown has begun, before writing its row', async () => {
    repo.findOne.mockResolvedValue(null); // batchId not taken
    Object.assign(repo, { create: jest.fn((b: Partial<MessageBatch>) => ({ ...b })) });
    await service.onModuleDestroy();

    const create = service.createBatch('s1', {
      messages: [{ chatId: 'c@c.us', type: 'text', content: { text: 'hi' } }],
    } as never);

    await expect(create).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.save).not.toHaveBeenCalled();
    expect(inFlightMarkers().size).toBe(0);
  });

  it('rejects a new batch (before persisting) when the concurrent in-flight cap is reached', async () => {
    const prev = process.env.BULK_MAX_CONCURRENT_BATCHES;
    process.env.BULK_MAX_CONCURRENT_BATCHES = '2';
    try {
      repo.findOne.mockResolvedValue(null); // batchId not taken
      (service as unknown as { inFlightBatches: number }).inFlightBatches = 2; // at cap
      const dto = { messages: [{ chatId: 'c@c.us', type: 'text', content: { text: 'hi' } }] };
      const create = service.createBatch('s1', dto as never);
      await expect(create).rejects.toThrow(/too many bulk batches/i);
      // A capacity refusal, not a malformed request: 429 is what clients retry on.
      await expect(create).rejects.toMatchObject({ status: 429 });
      expect(repo.save).not.toHaveBeenCalled(); // rejected before a PENDING row is written
    } finally {
      if (prev === undefined) delete process.env.BULK_MAX_CONCURRENT_BATCHES;
      else process.env.BULK_MAX_CONCURRENT_BATCHES = prev;
    }
  });

  // `content.text` is @MaxLength(4096)-validated BEFORE substitution, and the single-send template
  // path caps its FINAL render at template.renderMaxChars — the bulk path capped neither, so
  // caller-supplied variables inflated each item without bound.
  const batchWithVariables = (text: string, variables: Record<string, string>): MessageBatch => ({
    ...makeBatch(1),
    messages: [{ chatId: 'c0@c.us', type: 'text', content: { text }, variables }],
  });

  // The cap must bound the MESSAGE, not the payload. `variables` is a sibling of the media fields on
  // the same DTO, so personalised media is a supported bulk request — and a 100 KB image is ~137,000
  // base64 characters, twice the 64 KiB text cap. Capping every string in the content tree failed
  // exactly the requests this endpoint exists for.
  // The gate has TWO copies (see applySendingGate's doc); the envelope check landed on one of them.
  // A handler returning a truthy object without `input` fed `undefined` into every send below.
  it('fails an item when a message:sending handler returns a payload with no usable input', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValue({ continue: true, data: { notInput: 1 } });

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    const finalPartial = (repo.update.mock.calls as Array<[unknown, { results: BatchMessageResult[] }]>).at(-1)![1];
    expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
    expect(finalPartial.results[0].error?.message).toMatch(/message:sending/);
  });

  /**
   * The ONLY reason this second copy of the gate exists is that it must flag a plugin refusal apart
   * from a delivery failure, so the per-item `message:failed` hook is skipped. Nothing bound that:
   * deleting the flag on the envelope-refusal branch left the whole suite green, which means the
   * refusal would have been reported to every plugin as a failed delivery with no test noticing.
   */
  it('does not report an unusable envelope to plugins as a delivery failure', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValue({ continue: true, data: { notInput: 1 } });

    await runProcessBatch();

    expect(hookManager.execute).not.toHaveBeenCalledWith('message:failed', expect.anything(), expect.anything());
  });

  // Negative twin: a chain that returns nothing is the ordinary no-plugin path.
  it('keeps the original content when the hook chain returns no data', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValue({ continue: true });

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('sends a media item with variables even when its base64 exceeds the text cap', async () => {
    const bigBase64 = 'A'.repeat(137_000);
    repo.findOne.mockResolvedValue({
      ...makeBatch(1),
      messages: [
        {
          chatId: 'c0@c.us',
          type: 'image',
          content: { image: { base64: bigBase64, mimetype: 'image/jpeg' }, caption: 'Hi {{name}}' },
          variables: { name: 'Alice' },
        },
      ],
    });
    engine.sendImageMessage = jest.fn().mockResolvedValue({ id: 'wa1', timestamp: 1 });

    await runProcessBatch();

    expect(engine.sendImageMessage).toHaveBeenCalledTimes(1);
    const finalPartial = (repo.update.mock.calls as Array<[unknown, { results: BatchMessageResult[] }]>).at(-1)![1];
    expect(finalPartial.results[0].status).not.toBe(BatchMessageStatus.FAILED);
  });

  // The engines fetch only http(s) URLs and decode any other string as base64, so a media url is
  // checked for its scheme; after rendering, because `variables` may supply the whole URL.
  const imageBatch = (url: string, variables?: Record<string, string>): MessageBatch => ({
    ...makeBatch(1),
    messages: [{ chatId: 'c0@c.us', type: 'image', content: { image: { url } }, variables }],
  });

  it('sends a rendered media url whose variable holds a space', async () => {
    repo.findOne.mockResolvedValue(imageBatch('https://cdn.example.com/{{name}}.jpg', { name: 'John Doe' }));

    await runProcessBatch();

    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ data: 'https://cdn.example.com/John Doe.jpg' }),
    );
  });

  it('sends a media url that variables fill in whole', async () => {
    repo.findOne.mockResolvedValue(imageBatch('{{imageUrl}}', { imageUrl: 'https://cdn.example.com/a.jpg' }));

    await runProcessBatch();

    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ data: 'https://cdn.example.com/a.jpg' }),
    );
  });

  it.each([
    ['a rendered ftp url', '{{u}}', { u: 'ftp://example.com/a.jpg' }],
    ['an unfilled placeholder', '{{u}}', undefined],
    ['a scheme-less url', 'example.com/a.jpg', undefined],
  ])('fails an item with %s instead of sending it', async (_label, url, variables) => {
    repo.findOne.mockResolvedValue(imageBatch(url, variables));

    await runProcessBatch();

    expect(engine.sendImageMessage).not.toHaveBeenCalled();
    const finalPartial = (repo.update.mock.calls as Array<[unknown, { results: BatchMessageResult[] }]>).at(-1)![1];
    expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
    expect(finalPartial.results[0].error?.message).toMatch(/absolute http\(s\) URL/);
  });

  it('fails an item whose rendered text exceeds the cap instead of sending it', async () => {
    // Comfortably over the 64 KiB default the un-configured service falls back to.
    const huge = 'x'.repeat(70 * 1024);
    repo.findOne.mockResolvedValue(batchWithVariables('{{v}}', { v: huge }));

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    const finalPartial = (
      repo.update.mock.calls as Array<[unknown, { status: BatchStatus; results: BatchMessageResult[] }]>
    ).at(-1)![1];
    expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
    expect(finalPartial.results[0].error?.message).toMatch(/character limit/i);
  });

  /**
   * The cap covers text AND caption — a caption is the other caller-supplied string a template can
   * inflate without bound, and it lands in the same `messages.body` column. Only the text half was
   * bound: narrowing the loop to `['text']` left the suite green, so the caption half was a claim
   * with nothing behind it.
   */
  it('fails an item whose rendered CAPTION exceeds the cap', async () => {
    const huge = 'x'.repeat(70 * 1024);
    repo.findOne.mockResolvedValue({
      ...makeBatch(1),
      messages: [
        {
          chatId: 'c0@c.us',
          type: 'image',
          content: { image: { base64: 'AAAA', mimetype: 'image/jpeg' }, caption: '{{v}}' },
          variables: { v: huge },
        },
      ],
    });

    await runProcessBatch();

    const finalPartial = (
      repo.update.mock.calls as Array<[unknown, { status: BatchStatus; results: BatchMessageResult[] }]>
    ).at(-1)![1];
    expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
    expect(finalPartial.results[0].error?.message).toMatch(/caption/i);
  });

  it('still sends an item whose render stays under the cap', async () => {
    repo.findOne.mockResolvedValue(batchWithVariables('hello {{v}}', { v: 'world' }));

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    const sendArgs = engine.sendTextMessage.mock.calls[0] as [string, string];
    expect(sendArgs[1]).toBe('hello world');
  });

  // A restart or reconnect registers a fresh adapter mid-batch; the retired one is not ready, so a
  // batch holding it would fail every remaining item while the session is READY again.
  it('sends each item through the engine registered at that moment, not the one the batch started with', async () => {
    repo.findOne.mockResolvedValue(makeBatch(2));
    const replacement = { sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa2', timestamp: 222 }) };
    engine.sendTextMessage.mockImplementationOnce(() => {
      engines.set('s1', replacement as unknown as IWhatsAppEngine);
      return Promise.resolve({ id: 'wa1', timestamp: 111 });
    });

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(replacement.sendTextMessage).toHaveBeenCalledWith('c1@c.us', 'hi');
  });

  it('fails only the item whose engine is gone mid-batch, without feeding the send breaker', async () => {
    repo.findOne.mockResolvedValue(makeBatch(2));
    engine.sendTextMessage.mockImplementationOnce(() => {
      engines.delete('s1');
      return Promise.resolve({ id: 'wa1', timestamp: 111 });
    });

    await runProcessBatch();

    const finalPartial = (repo.update.mock.calls as Array<[unknown, { results: BatchMessageResult[] }]>).at(-1)![1];
    expect(finalPartial.results.map(r => r.status)).toEqual([BatchMessageStatus.SENT, BatchMessageStatus.FAILED]);
    expect(finalPartial.results[1].error?.message).toMatch(/not connected/i);
    expect(pacing.recordSendFailure).not.toHaveBeenCalled();
  });

  // The create-time check sees the raw input; a gate rewrite can still empty an item out.
  it('fails an item the message:sending gate rewrote into content its type cannot send', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValueOnce({ continue: true, data: { input: {} } });

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    const finalPartial = (repo.update.mock.calls as Array<[unknown, { results: BatchMessageResult[] }]>).at(-1)![1];
    expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
    expect(finalPartial.results[0].error?.message).toMatch(/content\.text/);
  });

  it('releases the in-flight marker when the engine is missing (no processingBatches leak)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    engines.delete('s1'); // engine-not-found → early-return path

    await runProcessBatch();

    expect(inFlightMarkers().has('b1')).toBe(false);
  });

  it('releases the in-flight marker when processing throws (no processingBatches leak)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    repo.update.mockRejectedValueOnce(new Error('db down')); // the first guarded write (→ PROCESSING) throws

    await runProcessBatch().catch(() => undefined);

    expect(inFlightMarkers().has('b1')).toBe(false);
  });

  it('persists every sent message so it appears in chat history / stats', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));

    await runProcessBatch();

    expect(messageService.saveOutgoingMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        waMessageId: 'wa1',
        chatId: 'c0@c.us',
        type: 'text',
        status: MessageStatus.SENT,
      }),
    );
  });

  it('persists the media and caption the item type sent, not a stray key on the same item', async () => {
    engine.sendVideoMessage = jest.fn().mockResolvedValue({ id: 'wa1', timestamp: 111 });
    const batch = makeBatch(2);
    batch.messages = [
      {
        chatId: 'c0@c.us',
        type: 'video',
        content: {
          text: 'not sent',
          caption: 'clip',
          image: { url: 'https://x/y.jpg', mimetype: 'image/jpeg' },
          video: { base64: 'AAAA', mimetype: 'video/mp4' },
        },
      },
      { chatId: 'c1@c.us', type: 'text', content: { text: 'hi', image: { url: 'https://x/y.jpg' } } },
    ];
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(messageService.saveOutgoingMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        chatId: 'c0@c.us',
        body: 'clip',
        metadata: { media: { mimetype: 'video/mp4', data: 'AAAA', filename: undefined } },
      }),
    );
    expect(messageService.saveOutgoingMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ chatId: 'c1@c.us', body: 'hi', metadata: undefined }),
    );
  });

  it('persists the mimetype the engine was given when a base64 item declares none', async () => {
    const batch = makeBatch(1);
    batch.messages = [{ chatId: 'c0@c.us', type: 'image', content: { image: { base64: 'AAAA' } } }];
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ mimetype: 'image/jpeg', data: 'AAAA' }),
    );
    expect(messageService.saveOutgoingMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ metadata: { media: { mimetype: 'image/jpeg', data: 'AAAA', filename: undefined } } }),
    );
  });

  it('lets a URL item with no declared mimetype take the fetched type, as a single send does', async () => {
    const batch = makeBatch(2);
    batch.messages = [
      { chatId: 'c0@c.us', type: 'image', content: { image: { url: 'https://x/y.png' } } },
      { chatId: 'c1@c.us', type: 'audio', content: { audio: { url: 'https://x/v.ogg' } } },
    ];
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    // The placeholder both engines read as "unknown", so the fetched Content-Type wins.
    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ mimetype: 'application/octet-stream', data: 'https://x/y.png' }),
    );
    expect(engine.sendAudioMessage).toHaveBeenCalledWith(
      'c1@c.us',
      expect.objectContaining({ mimetype: 'application/octet-stream', data: 'https://x/v.ogg' }),
    );
  });

  it('runs the message:sending gate for each bulk message (bulk no longer bypasses moderation)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));

    await runProcessBatch();

    // The recipient is in `input`, as on a single send, so a recipient-based plugin can decide.
    expect(hookManager.execute).toHaveBeenCalledWith(
      'message:sending',
      expect.objectContaining({ type: 'text', sessionId: 's1', input: { text: 'hi', chatId: 'c0@c.us' } }),
      expect.objectContaining({ source: 'BulkMessageService' }),
    );
    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'hi');
  });

  it('keeps sending an item to its own recipient when the gate rewrites input.chatId', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValueOnce({ continue: true, data: { input: { text: 'hi', chatId: 'x@c.us' } } });

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'hi');
  });

  it('fails just the plugin-blocked message (continue:false) without calling the engine for it', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValueOnce({ continue: false, data: {} }); // block message 0

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });

  it('fires message:failed when a bulk send fails (bulk failures were previously invisible to plugins)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    engine.sendTextMessage.mockRejectedValueOnce(new Error('boom'));

    await runProcessBatch();

    expect(hookManager.execute).toHaveBeenCalledWith(
      'message:failed',
      expect.objectContaining({ type: 'text', error: 'boom', input: { text: 'hi', chatId: 'c0@c.us' } }),
      expect.objectContaining({ source: 'BulkMessageService' }),
    );
  });

  it('logs the in-page summary of a page error; the stored result and the hook keep only its reason and build', async () => {
    const batch = makeBatch(1);
    repo.findOne.mockResolvedValue(batch);
    engine.sendTextMessage.mockRejectedValueOnce(
      new EnginePageError(
        { name: 'TypeError', message: 'x', build: '2.3000.1' },
        new Error('page threw {"build":"2.3000.1","stack":"at y"}'),
      ),
    );
    const warn = jest.spyOn((service as unknown as { logger: LoggerService }).logger, 'warn').mockImplementation();

    await runProcessBatch();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('page threw {"build":"2.3000.1"'));
    const result = batch.results[0];
    expect(result.status).toBe(BatchMessageStatus.FAILED);
    expect(result.error?.message).toBe('WhatsApp Web rejected the operation: TypeError: x (build 2.3000.1)');
    expect(hookManager.execute).toHaveBeenCalledWith(
      'message:failed',
      expect.objectContaining({ error: 'WhatsApp Web rejected the operation: TypeError: x (build 2.3000.1)' }),
      expect.anything(),
    );
  });

  it('never logs the cause of a blocked media URL', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    const blocked = new SsrfBlockedError('blocked');
    blocked.cause = new Error('resolved to 10.0.0.1');
    engine.sendTextMessage.mockRejectedValueOnce(blocked);
    const warn = jest.spyOn((service as unknown as { logger: LoggerService }).logger, 'warn').mockImplementation();

    await runProcessBatch();

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('10.0.0.1');
  });

  it('does NOT fire message:failed when the gate blocks a bulk item (a block is a moderation decision, not a delivery failure)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    hookManager.execute.mockResolvedValueOnce({ continue: false, data: {} }); // block message 0

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    // A moderation block must not be reported as a delivery failure — matches single send, where a
    // block is a 400 with no message:failed.
    expect(hookManager.execute).not.toHaveBeenCalledWith('message:failed', expect.anything(), expect.anything());
  });

  it('feeds the pacing breaker: a successful bulk send records success, so bulk can reset a streak', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));

    await runProcessBatch();

    expect(pacing.recordSendSuccess).toHaveBeenCalledWith('s1');
    expect(pacing.recordSendFailure).not.toHaveBeenCalled();
  });

  it('feeds the pacing breaker: an engine refusal records a failure, so bulk can trip the streak', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    engine.sendTextMessage.mockRejectedValueOnce(new Error('boom'));

    await runProcessBatch();

    // The engine was asked and refused — exactly what the breaker's streak counts, just like the
    // single-send path (message.service failSend). A success never happened, so no reset.
    expect(pacing.recordSendFailure).toHaveBeenCalledWith('s1');
    expect(pacing.recordSendSuccess).not.toHaveBeenCalled();
  });

  it('a pacing 429 fails the item WITHOUT a message:failed hook or a breaker increment (policy, not delivery)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    pacing.assertSendAllowed.mockRejectedValueOnce(
      new HttpException({ statusCode: 429, code: SEND_PACING_LIMITED }, 429),
    );

    await runProcessBatch();

    // Thrown before the engine was asked: not a delivery failure (no message:failed), and it must
    // not feed the breaker — matching single send, where a pacing refusal is a bare 429.
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(hookManager.execute).not.toHaveBeenCalledWith('message:failed', expect.anything(), expect.anything());
    expect(pacing.recordSendFailure).not.toHaveBeenCalled();
  });

  // Bulk writes an item's row only after the engine accepts it, so an item that fails first must stop
  // counting against the caps at once, or it refuses the next item for the rest of the hold.
  it.each([
    ['a plugin blocks it', () => hookManager.execute.mockResolvedValueOnce({ continue: false })],
    ['the engine refuses it', () => engine.sendTextMessage.mockRejectedValueOnce(new EngineRefusedError('refused'))],
    [
      'WhatsApp throttles it',
      () => engine.sendTextMessage.mockRejectedValueOnce(new EngineThrottledError('rate-overlimit')),
    ],
    ['its media URL is blocked', () => engine.sendTextMessage.mockRejectedValueOnce(new SsrfBlockedError('blocked'))],
  ])('releases the pacing admission of an item that fails before its row when %s', async (_label, arrange) => {
    const release = jest.fn();
    pacing.assertSendAllowed.mockResolvedValue(release);
    repo.findOne.mockResolvedValue(makeBatch(1));
    arrange();

    await runProcessBatch();

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalledWith(true);
  });

  it.each([
    ['the engine accepts it', () => undefined],
    [
      'the engine fails with an unknown outcome',
      () => engine.sendTextMessage.mockRejectedValueOnce(new Error('timeout')),
    ],
    [
      'the engine transport fails',
      () => engine.sendTextMessage.mockRejectedValueOnce(new EngineTransportError('timeout')),
    ],
  ])('keeps the pacing admission held for a window from the engine return when %s', async (_label, arrange) => {
    const release = jest.fn();
    pacing.assertSendAllowed.mockResolvedValue(release);
    repo.findOne.mockResolvedValue(makeBatch(1));
    arrange();

    await runProcessBatch();

    expect(release.mock.calls).toEqual([[true]]);
  });

  // The item's row lands only after the engine call, which a media URL fetch or an upload can stretch past
  // the hold window, so the admission is held until the engine returns rather than from the check.
  it('holds the pacing admission until the engine call returns', async () => {
    const release = jest.fn();
    pacing.assertSendAllowed.mockResolvedValue(release);
    repo.findOne.mockResolvedValue(makeBatch(1));
    let settledDuringSend = -1;
    engine.sendTextMessage.mockImplementationOnce(() => {
      settledDuringSend = release.mock.calls.length;
      return Promise.resolve({ id: 'wa1', timestamp: 111 });
    });

    await runProcessBatch();

    expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1', expect.any(String), { untilSettled: true });
    expect(settledDuringSend).toBe(0);
    expect(release.mock.calls).toEqual([[true]]);
  });

  it('sends a bulk audio item with ptt as a voice note and persists type "voice"', async () => {
    engine.sendAudioMessage = jest.fn().mockResolvedValue({ id: 'wa2', timestamp: 222 });
    const batch = {
      id: 'b1',
      batchId: 'bx',
      sessionId: 's1',
      status: BatchStatus.PENDING,
      currentIndex: 0,
      messages: [{ chatId: 'c0@c.us', type: 'audio', content: { audio: { url: 'https://x/v', ptt: true } } }],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
      results: [],
    } as unknown as MessageBatch;
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendAudioMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ ptt: true, mimetype: 'audio/ogg; codecs=opus' }),
    );
    expect(messageService.saveOutgoingMessage).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'voice' }));
  });

  it('strips base64 media payloads from the stored batch once it completes (footprint)', async () => {
    engine.sendImageMessage = jest.fn().mockResolvedValue({ id: 'waimg', timestamp: 222 });
    const batch = makeBatch(1);
    batch.messages = [
      {
        chatId: 'c0@c.us',
        type: 'image',
        content: {
          image: { base64: 'data:image/png;base64,QkFTRTY0SU1BR0U=', mimetype: 'image/png', filename: 'p.png' },
        },
      },
    ];
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ data: 'QkFTRTY0SU1BR0U=' }),
    );

    // A completed batch is terminal (never resumed), so the persisted message_batches.messages must not
    // retain the (often multi-MB) base64 — only the descriptive fields are kept. The terminal write is
    // the last guarded UPDATE (start transition and progress writes carry no messages payload).
    const finalPartial = (repo.update.mock.calls as Array<[unknown, { messages: MessageBatch['messages'] }]>).at(
      -1,
    )![1];
    const img = (finalPartial.messages[0].content as { image?: { base64?: unknown; mimetype?: string } }).image;
    expect(img?.base64).toBeUndefined();
    expect(img?.mimetype).toBe('image/png');
  });

  it('rejects an empty base64 data URI before persisting or dispatching the batch', async () => {
    const dto = {
      messages: [
        {
          chatId: 'c0@c.us',
          type: 'image' as const,
          content: { image: { base64: 'data:image/png;base64,', mimetype: 'image/png' } },
        },
      ],
    };

    await expect(service.createBatch('s1', dto)).rejects.toThrow('Either url or base64');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('persists the media filename from the chosen media type (image), not just from document', async () => {
    engine.sendImageMessage = jest.fn().mockResolvedValue({ id: 'waimg', timestamp: 222 });
    const batch = makeBatch(1);
    batch.messages = [
      {
        chatId: 'c0@c.us',
        type: 'image',
        content: { image: { base64: 'QkFTRTY0SU1BR0U=', mimetype: 'image/png', filename: 'p.png' } },
      },
    ];
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    const imageSave = (
      messageService.saveOutgoingMessage.mock.calls as Array<
        [string, { type: string; metadata?: { media?: { filename?: string } } }]
      >
    ).find(([, payload]) => payload.type === 'image');
    expect(imageSave?.[1].metadata?.media?.filename).toBe('p.png');
  });

  it('stops sending when the batch is cancelled in the DB by another instance/restart', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(3)) // pickup
      .mockResolvedValueOnce({ status: BatchStatus.CANCELLED }); // re-read after the progress write missed
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition → PROCESSING
      .mockResolvedValueOnce({ affected: 0 }) // progress write at i=0 loses to the committed CANCELLED
      .mockResolvedValue({ affected: 1 });

    await runProcessBatch();

    // Only the first message (before the guarded progress write saw the cancel) was sent.
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    // The terminal write persists CANCELLED with reconciled counters — never a PROCESSING rewrite.
    // It is an UPDATE, not a save: when the row is gone (its session was deleted, which also reads
    // as a 0-row progress write), a save would INSERT it again.
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenLastCalledWith(
      { id: 'b1', status: In([BatchStatus.PROCESSING, BatchStatus.CANCELLED]) },
      expect.objectContaining({ status: BatchStatus.CANCELLED, completedAt: expect.any(Date) as unknown }),
    );
  });

  // A session deleted mid-run takes the batch row with it; that reads as a cancel, as before.
  it('treats a batch row deleted mid-run as a cancel', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(3)) // pickup
      .mockResolvedValueOnce(null); // re-read after the progress write missed: the row is gone
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockResolvedValueOnce({ affected: 0 }) // progress write at i=0
      .mockResolvedValue({ affected: 0 }); // the reconciling write finds no row either

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenNthCalledWith(
      3,
      { id: 'b1', status: In([BatchStatus.PROCESSING, BatchStatus.CANCELLED]) },
      expect.objectContaining({ status: BatchStatus.CANCELLED }),
    );
    // The reconciliation found no row, so the results write follows; guarded on FAILED, it matches
    // nothing either.
    expect(repo.update).toHaveBeenLastCalledWith({ id: 'b1', status: BatchStatus.FAILED }, expect.anything());
  });

  // The row is what GET batch status, a cancel on another node and the reapers read, so each item's
  // outcome goes on it before the next is sent, and a cancel committed elsewhere stops the next item.
  it('saves progress after every item and stops on the next item after a cancel elsewhere', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(5)) // pickup
      .mockResolvedValueOnce({ status: BatchStatus.CANCELLED }); // re-read after a progress write missed
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockResolvedValueOnce({ affected: 1 }) // progress write at i=0
      .mockResolvedValueOnce({ affected: 1 }) // progress write at i=1
      .mockResolvedValueOnce({ affected: 0 }) // progress write at i=2 meets the committed CANCELLED
      .mockResolvedValue({ affected: 1 });

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(3);
    const progressWrites = (repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>).filter(
      ([criteria, partial]) =>
        JSON.stringify(criteria) === JSON.stringify({ id: 'b1', status: BatchStatus.PROCESSING }) &&
        partial.status === undefined,
    );
    expect(progressWrites.map(([, partial]) => partial.currentIndex)).toEqual([1, 2, 3]);
  });

  // A lapsed lease does not mean a dead process: a node whose engine went away stops renewing while
  // its batch loop runs on. Another node that takes the session over fails the batch; this run keeps
  // that FAILED and records only the items it sent.
  it('stops without writing over a batch another node failed mid-run, keeping what it sent', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(3)) // pickup
      .mockResolvedValueOnce({ status: BatchStatus.FAILED }); // re-read after the progress write missed
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockResolvedValueOnce({ affected: 0 }); // progress write at i=0: the row is FAILED now

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledTimes(3);
    const [criteria, partial] = (repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>).at(-1)!;
    expect(criteria).toEqual({ id: 'b1', status: BatchStatus.FAILED });
    expect(partial.status).toBeUndefined(); // the reap's FAILED stays
    expect(partial.completedAt).toBeUndefined();
    expect(partial).toMatchObject({ currentIndex: 1, progress: expect.objectContaining({ sent: 1 }) as unknown });
    expect(partial.results).toHaveLength(1);
  });

  it('leaves the status of a batch another node failed before its last write, keeping what it sent', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(1)) // pickup
      .mockResolvedValueOnce({ status: BatchStatus.FAILED }); // pre-final re-read
    await runProcessBatch();

    const calls = repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>;
    expect(calls.map(([, p]) => p.status)).toEqual([BatchStatus.PROCESSING, undefined, undefined]);
    const [criteria, partial] = calls.at(-1)!;
    expect(criteria).toEqual({ id: 'b1', status: BatchStatus.FAILED }); // results only, never a status
    expect(partial).toMatchObject({ currentIndex: 1, progress: expect.objectContaining({ sent: 1 }) as unknown });
    expect(partial.results).toHaveLength(1);
    expect(partial.completedAt).toBeUndefined();
    expect(partial.messages).toBeUndefined();
  });

  it('sends nothing when the batch row is already CANCELLED at pickup (cancel-before-start)', async () => {
    const batch = makeBatch(3);
    batch.status = BatchStatus.CANCELLED; // cancelBatch committed before this process picked the batch up
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled(); // no PROCESSING transition is even attempted
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('sends nothing when the in-memory cancel flag was set before pickup (same-process cancel-before-start)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(3));
    inFlightMarkers().set('b1', false); // cancelBatch ran before processBatch got to the batch

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(inFlightMarkers().has('b1')).toBe(false); // marker still released
  });

  // A run starts only from PENDING: a cancel, or a reap after another node adopted the session, that
  // committed before the start transition leaves the row CANCELLED or FAILED, and nothing is sent.
  it('sends nothing when a cancel or a reap commits between pickup and the guarded start transition', async () => {
    repo.findOne.mockResolvedValue(makeBatch(3));
    repo.update.mockResolvedValueOnce({ affected: 0 }); // the row left PENDING before the first write

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledTimes(1); // the guarded start transition only
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'b1', status: BatchStatus.PENDING },
      expect.objectContaining({ status: BatchStatus.PROCESSING }),
    );
    expect(repo.save).not.toHaveBeenCalled(); // nothing is written after losing to the cancel
  });

  it('stops after the in-flight item when cancelled mid-batch, and no write resurrects the batch', async () => {
    repo.findOne.mockResolvedValue(makeBatch(3));
    engine.sendTextMessage.mockImplementationOnce(() => {
      inFlightMarkers().set('b1', false); // cancelBatch lands while the first send is in flight
      return Promise.resolve({ id: 'wa1', timestamp: 111 });
    });

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1); // the remaining two items were not sent
    expect(repo.save).not.toHaveBeenCalled();
    const finalPartial = (repo.update.mock.calls as Array<[unknown, { status?: BatchStatus }]>).at(-1)![1];
    expect(finalPartial.status).toBe(BatchStatus.CANCELLED);
    // No guarded write ever carried a non-cancelled terminal status back to the row.
    for (const [, partial] of repo.update.mock.calls as Array<[unknown, { status?: BatchStatus }]>) {
      expect(partial.status).not.toBe(BatchStatus.COMPLETED);
      expect(partial.status).not.toBe(BatchStatus.FAILED);
    }
  });

  it('does not clobber a CANCELLED that landed after the last guarded write (final write is guarded too)', async () => {
    const batch = makeBatch(1);
    repo.findOne
      .mockResolvedValueOnce(batch) // processBatch initial load
      .mockResolvedValueOnce({ status: BatchStatus.PROCESSING }) // pre-final re-read — cancel not visible yet
      .mockResolvedValueOnce({ status: BatchStatus.CANCELLED }); // after the final write missed
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition → PROCESSING
      .mockResolvedValueOnce({ affected: 1 }) // progress write (i=0, also the last item)
      .mockResolvedValueOnce({ affected: 0 }); // final write loses the race to a committed CANCELLED

    await runProcessBatch();

    expect(batch.status).toBe(BatchStatus.CANCELLED); // terminal state follows the DB, not the runner
    expect(repo.save).not.toHaveBeenCalled(); // no unguarded terminal write happened
    const calls = repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>;
    expect(calls[2][0]).toEqual({ id: 'b1', status: BatchStatus.PROCESSING }); // the guarded final write
    // The cancel keeps its status; the run's results and reconciled counters go under it.
    expect(calls[3][0]).toEqual({ id: 'b1', status: BatchStatus.CANCELLED });
    expect(calls[3][1].status).toBeUndefined();
    expect(calls[3][1].results).toHaveLength(1);
  });

  // The loop can stop before an item's progress save (stopOnError here), so the final write is the only
  // place the last item is recorded. A reap or a cross-process cancel that wins it keeps its status, and those
  // items still go on the row: as they are under FAILED, reconciled as cancelBatch would under CANCELLED.
  it.each([
    [BatchStatus.FAILED, { sent: 2, failed: 1, pending: 1, cancelled: 0 }],
    [BatchStatus.CANCELLED, { sent: 2, failed: 1, pending: 0, cancelled: 1 }],
  ])('keeps the %s that won the final write race, and records what the run sent', async (winner, progress) => {
    const batch = makeBatch(4);
    batch.options = { ...batch.options, stopOnError: true };
    engine.sendTextMessage
      .mockResolvedValueOnce({ id: 'wa1', timestamp: 111 }) // i=0, saved by its progress write
      .mockResolvedValueOnce({ id: 'wa2', timestamp: 112 }) // i=1, saved by its progress write
      .mockRejectedValueOnce(new Error('boom')); // i=2 fails and stops the loop before its save
    repo.findOne
      .mockResolvedValueOnce(batch) // pickup
      .mockResolvedValueOnce({ status: BatchStatus.PROCESSING }) // pre-final re-read
      .mockResolvedValueOnce({ status: winner }); // after the final write missed
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockResolvedValueOnce({ affected: 1 }) // progress write at i=0
      .mockResolvedValueOnce({ affected: 1 }) // progress write at i=1
      .mockResolvedValueOnce({ affected: 0 }); // final write loses the race

    await runProcessBatch();

    expect(batch.status).toBe(winner);
    expect(repo.update).toHaveBeenCalledTimes(5);
    const [criteria, partial] = (repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>).at(-1)!;
    expect(criteria).toEqual({ id: 'b1', status: winner });
    expect(partial.status).toBeUndefined();
    expect(partial.completedAt).toBeUndefined();
    expect(partial.results).toHaveLength(3);
    expect(partial.progress).toEqual(expect.objectContaining(progress));
  });

  it('records what the run sent when a reap beats its cancel reconciliation', async () => {
    repo.findOne
      .mockResolvedValueOnce(makeBatch(3)) // pickup
      .mockResolvedValueOnce({ status: BatchStatus.PROCESSING }); // pre-final re-read
    engine.sendTextMessage.mockImplementationOnce(() => {
      inFlightMarkers().set('b1', false); // a cancel on this node lands while the first send is in flight
      return Promise.resolve({ id: 'wa1', timestamp: 111 });
    });
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition
      .mockResolvedValueOnce({ affected: 1 }) // progress write at i=0
      .mockResolvedValueOnce({ affected: 0 }); // the CANCELLED reconciliation loses to the reap

    await runProcessBatch();

    const calls = repo.update.mock.calls as Array<[unknown, Partial<MessageBatch>]>;
    expect(calls).toHaveLength(4);
    expect(calls[2][0]).toEqual({ id: 'b1', status: In([BatchStatus.PROCESSING, BatchStatus.CANCELLED]) });
    expect(calls[3][0]).toEqual({ id: 'b1', status: BatchStatus.FAILED });
    expect(calls[3][1].status).toBeUndefined();
    expect(calls[3][1].results).toHaveLength(1);
    // That cancel never took effect, so the FAILED row keeps the unreconciled counters.
    expect(calls[3][1].progress).toMatchObject({ sent: 1, pending: 2, cancelled: 0 });
  });

  it('substitutes canonical {{name}} placeholders in bulk content', async () => {
    const batch = makeBatch(1);
    batch.messages[0].content = { text: 'Hi {{name}}' };
    batch.messages[0].variables = { name: 'Sam' };
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'Hi Sam');
  });

  it('still substitutes legacy single-brace {name} placeholders (backward compatible)', async () => {
    const batch = makeBatch(1);
    batch.messages[0].content = { text: 'Hi {name}' };
    batch.messages[0].variables = { name: 'Sam' };
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'Hi Sam');
  });

  it('tags participants per item, on the text body and on a media caption alike', async () => {
    // Each item names its own list: a batch fans out to many chats, and a WID is only taggable in a
    // chat the participant is actually in.
    const batch = makeBatch(1);
    batch.messages[0].content = { text: 'Hi @62811', mentions: ['62811@c.us'] };
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'Hi @62811', ['62811@c.us']);

    const media = makeBatch(1);
    media.messages[0].type = 'image';
    media.messages[0].content = {
      image: { base64: 'AAAA', mimetype: 'image/jpeg' },
      caption: 'look @62811',
      mentions: ['62811@c.us'],
    };
    repo.findOne.mockResolvedValue(media);

    await runProcessBatch();

    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ caption: 'look @62811', mentions: ['62811@c.us'] }),
    );
  });

  it('substitutes variables inside mentions, so a campaign can tag a different participant per item', async () => {
    // applyVariables walks the whole content tree, so a placeholder in a WID is rendered like one in
    // the body. That is load-bearing for a personalised batch, and nothing else pins it: a future
    // rewrite of applyVariables that rebuilt the object field by field would drop mentions silently.
    const batch = makeBatch(1);
    batch.messages[0].content = { text: 'Hi @{{num}}', mentions: ['{{num}}@c.us'] };
    batch.messages[0].variables = { num: '62811' };
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'Hi @62811', ['62811@c.us']);
  });

  it('tags an audio item too, which has no caption to anchor a visible @token', async () => {
    // Audio carries no caption, but a mention still tags through contextInfo, which is why the
    // single-send audio route accepts the field. Skipping it here would accept the list and deliver
    // an untagged voice note, turning a clear 400 into a silent no-op for one bulk type only.
    const batch = makeBatch(1);
    batch.messages[0].type = 'audio';
    batch.messages[0].content = { audio: { base64: 'AAAA', mimetype: 'audio/mpeg' }, mentions: ['62811@c.us'] };
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendAudioMessage).toHaveBeenCalledWith(
      'c0@c.us',
      expect.objectContaining({ mentions: ['62811@c.us'] }),
    );
  });

  it('leaves an untagged batch item on its two-argument send', async () => {
    // Control: without a list the call shape every existing batch makes is untouched.
    const batch = makeBatch(1);
    batch.messages[0].content = { text: 'Hi there', mentions: [] };
    repo.findOne.mockResolvedValue(batch);

    await runProcessBatch();

    expect(engine.sendTextMessage).toHaveBeenCalledWith('c0@c.us', 'Hi there');
  });

  it('fails an item whose rendered variables grow its base64 media past the cap (no send, explicit failure)', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '16';
    try {
      engine.sendImageMessage = jest.fn().mockResolvedValue({ id: 'waimg', timestamp: 222 });
      const batch = makeBatch(1);
      // The raw placeholder passes the create-time cap check; the rendered value does not.
      batch.messages = [
        {
          chatId: 'c0@c.us',
          type: 'image',
          content: { image: { base64: '{{payload}}', mimetype: 'image/png' } },
          variables: { payload: Buffer.alloc(32).toString('base64') },
        },
      ];
      repo.findOne.mockResolvedValue(batch);

      await runProcessBatch();

      expect(engine.sendImageMessage).not.toHaveBeenCalled(); // the oversized media was NOT sent
      const failedCall = (
        hookManager.execute.mock.calls as Array<[string, { type: string; error: string }, unknown]>
      ).find(([event]) => event === 'message:failed');
      expect(failedCall?.[1].type).toBe('image');
      expect(failedCall?.[1].error).toContain('exceeds the maximum allowed size');
      const finalPartial = (
        repo.update.mock.calls as Array<[unknown, { status: BatchStatus; results: BatchMessageResult[] }]>
      ).at(-1)![1];
      expect(finalPartial.status).toBe(BatchStatus.FAILED); // the only item failed → batch FAILED
      expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
      expect(finalPartial.results[0].error?.message).toContain('exceeds the maximum allowed size');
    } finally {
      delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    }
  });

  it('fails an item the message:sending gate rewrote past the media cap (gate output is re-validated)', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '16';
    try {
      engine.sendImageMessage = jest.fn().mockResolvedValue({ id: 'waimg', timestamp: 222 });
      const batch = makeBatch(1);
      batch.messages = [
        {
          chatId: 'c0@c.us',
          type: 'image',
          content: { image: { base64: Buffer.alloc(4).toString('base64'), mimetype: 'image/png' } },
        },
      ];
      repo.findOne.mockResolvedValue(batch);
      // The gate allows the send but swaps in a payload that exceeds the cap.
      hookManager.execute.mockImplementationOnce(() =>
        Promise.resolve({
          continue: true,
          data: { input: { image: { base64: Buffer.alloc(32).toString('base64'), mimetype: 'image/png' } } },
        }),
      );

      await runProcessBatch();

      expect(engine.sendImageMessage).not.toHaveBeenCalled();
      const finalPartial = (
        repo.update.mock.calls as Array<[unknown, { status: BatchStatus; results: BatchMessageResult[] }]>
      ).at(-1)![1];
      expect(finalPartial.results[0].status).toBe(BatchMessageStatus.FAILED);
      expect(finalPartial.results[0].error?.message).toContain('exceeds the maximum allowed size');
    } finally {
      delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    }
  });
});

describe('BulkMessageService.cancelBatch', () => {
  let service: BulkMessageService;
  let repo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };

  const batchWithStatus = (status: BatchStatus): MessageBatch =>
    ({
      id: 'b1',
      batchId: 'bx',
      sessionId: 's1',
      status,
      messages: [],
      options: {},
      progress: { total: 2, sent: 0, failed: 0, pending: 2, cancelled: 0 },
      results: [],
    }) as unknown as MessageBatch;

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        EngineRegistry,
        { provide: MessageService, useValue: {} },
        {
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        { provide: HookManager, useValue: { execute: jest.fn() } },
      ],
    }).compile();
    service = module.get(BulkMessageService);
  });

  it('rejects a cancel on a terminally FAILED batch (does not overwrite the failure to CANCELLED)', async () => {
    // A FAILED batch reached its terminal state because real sends failed (stopOnError, or all sends
    // failed). Overwriting it to CANCELLED would mask the delivery failure and the message:failed
    // events that already fired. FAILED is terminal, like COMPLETED/CANCELLED.
    repo.findOne.mockResolvedValue(batchWithStatus(BatchStatus.FAILED));
    await expect(service.cancelBatch('s1', 'bx')).rejects.toThrow(/already failed/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a cancel on an already-COMPLETED batch', async () => {
    repo.findOne.mockResolvedValue(batchWithStatus(BatchStatus.COMPLETED));
    await expect(service.cancelBatch('s1', 'bx')).rejects.toThrow(/already completed/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a cancel on an already-CANCELLED batch', async () => {
    repo.findOne.mockResolvedValue(batchWithStatus(BatchStatus.CANCELLED));
    await expect(service.cancelBatch('s1', 'bx')).rejects.toThrow(/already cancelled/i);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('cancels a PENDING batch (the supported case) and moves pending items to cancelled', async () => {
    const batch = batchWithStatus(BatchStatus.PENDING);
    repo.findOne.mockResolvedValue(batch);
    const result = await service.cancelBatch('s1', 'bx');
    expect(result.status).toBe(BatchStatus.CANCELLED);
    expect(result.progress.cancelled).toBe(2);
    expect(result.progress.pending).toBe(0);
    // The write is guarded to the non-terminal statuses inside the UPDATE itself.
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'b1', status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
      expect.objectContaining({ status: BatchStatus.CANCELLED }),
    );
  });

  // Only the process running a batch removes its marker, and a marker makes the takeover reap skip
  // the batch, so a cancel must not leave one behind for a batch this process is not running.
  it('leaves no in-flight marker for a batch another process is running', async () => {
    repo.findOne.mockResolvedValue(batchWithStatus(BatchStatus.PROCESSING));

    await service.cancelBatch('s1', 'bx');

    expect((service as unknown as { processingBatches: Map<string, boolean> }).processingBatches.has('b1')).toBe(false);
  });

  it('signals the run of a batch this process is running', async () => {
    const markers = (service as unknown as { processingBatches: Map<string, boolean> }).processingBatches;
    markers.set('b1', true);
    repo.findOne.mockResolvedValue(batchWithStatus(BatchStatus.PROCESSING));

    await service.cancelBatch('s1', 'bx');

    expect(markers.get('b1')).toBe(false);
  });

  it('rejects when the batch turns terminal between the read and the guarded write (no relabelling)', async () => {
    repo.findOne
      .mockResolvedValueOnce(batchWithStatus(BatchStatus.PROCESSING)) // upfront read — still running
      .mockResolvedValueOnce({ status: BatchStatus.COMPLETED }); // re-read after the write matched nothing
    repo.update.mockResolvedValueOnce({ affected: 0 }); // the batch completed in between

    await expect(service.cancelBatch('s1', 'bx')).rejects.toThrow(/already completed/i);
  });
});

describe('BulkMessageService.createBatch base64 media cap', () => {
  let service: BulkMessageService;
  let repo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; update: jest.Mock };
  let engines: EngineRegistry;
  let messageService: { saveOutgoingMessage: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
      create: jest.fn().mockImplementation((b: MessageBatch) => Object.assign({ id: 'b1' }, b)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    engines = new EngineRegistry();
    // These suites exercise batch bookkeeping across several session ids, so every session is
    // "started" here; the engine itself is never called.
    for (const id of ['s1', 's2']) engines.set(id, {} as IWhatsAppEngine);
    messageService = { saveOutgoingMessage: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        { provide: EngineRegistry, useValue: engines },
        { provide: MessageService, useValue: messageService },
        {
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        {
          provide: HookManager,
          useValue: {
            execute: jest
              .fn()
              .mockImplementation((_e: string, d: unknown) => Promise.resolve({ continue: true, data: d })),
          },
        },
      ],
    }).compile();
    service = module.get<BulkMessageService>(BulkMessageService);
  });

  it('rejects a message whose base64 media exceeds the cap, before persisting the batch', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
    try {
      await expect(
        service.createBatch('s1', {
          messages: [
            {
              chatId: 'c0@c.us',
              type: 'image',
              content: { image: { base64: Buffer.alloc(1025).toString('base64'), mimetype: 'image/png' } },
            },
          ],
        } as unknown as SendBulkMessageDto),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(repo.save).not.toHaveBeenCalled();
    } finally {
      delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    }
  });

  it('refuses a non-http(s) media url at batch creation but lets a templated one through', async () => {
    const create = (url: string) =>
      service.createBatch('s1', {
        messages: [{ chatId: 'c0@c.us', type: 'image' as const, content: { image: { url } } }],
      });

    await expect(create('ftp://example.com/a.jpg')).rejects.toThrow(/absolute http\(s\) URL/);
    expect(repo.save).not.toHaveBeenCalled();
    await expect(create('https://{{host}}/a.jpg')).resolves.toBeDefined();
  });

  it('reserves the cap before awaiting persistence so concurrent creates cannot overshoot it', async () => {
    const previous = process.env.BULK_MAX_CONCURRENT_BATCHES;
    process.env.BULK_MAX_CONCURRENT_BATCHES = '1';
    let releaseSave!: (batch: MessageBatch) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>(resolve => {
      markSaveStarted = resolve;
    });
    const pendingSave = new Promise<MessageBatch>(resolve => {
      releaseSave = resolve;
    });
    let persistedBatch!: MessageBatch;
    repo.save.mockImplementationOnce((batch: MessageBatch) => {
      persistedBatch = batch;
      markSaveStarted();
      return pendingSave;
    });
    const dto = {
      messages: [{ chatId: 'c0@c.us', type: 'text' as const, content: { text: 'hi' } }],
    } as unknown as SendBulkMessageDto;

    try {
      const first = service.createBatch('s1', dto);
      await saveStarted;

      await expect(service.createBatch('s1', dto)).rejects.toThrow(/too many bulk batches/i);
      expect(repo.save).toHaveBeenCalledTimes(1);

      releaseSave(persistedBatch);
      await expect(first).resolves.toBe(persistedBatch);
    } finally {
      if (previous === undefined) delete process.env.BULK_MAX_CONCURRENT_BATCHES;
      else process.env.BULK_MAX_CONCURRENT_BATCHES = previous;
    }
  });

  it('releases the cap reservation when persistence fails', async () => {
    repo.save.mockRejectedValueOnce(new Error('database unavailable'));
    const dto = {
      messages: [{ chatId: 'c0@c.us', type: 'text' as const, content: { text: 'hi' } }],
    } as unknown as SendBulkMessageDto;

    await expect(service.createBatch('s1', dto)).rejects.toThrow('database unavailable');

    expect((service as unknown as { inFlightBatches: number }).inFlightBatches).toBe(0);
    // The marker registered before the write is dropped too.
    expect((service as unknown as { processingBatches: Map<string, boolean> }).processingBatches.size).toBe(0);
  });

  it.each([
    ['a text item with no text', { chatId: 'c0@c.us', type: 'text', content: {} }, /content\.text/],
    ['a text item with empty text', { chatId: 'c0@c.us', type: 'text', content: { text: '' } }, /content\.text/],
    ['an image item with no media', { chatId: 'c0@c.us', type: 'image', content: {} }, /content\.image\.url/],
    [
      'a document item whose media sits under another type',
      { chatId: 'c0@c.us', type: 'document', content: { image: { url: 'https://example.com/a.jpg' } } },
      /content\.document\.url/,
    ],
  ])('rejects %s with a 400 before persisting the batch', async (_label, item, message) => {
    const create = service.createBatch('s1', { messages: [item] } as unknown as SendBulkMessageDto);

    await expect(create).rejects.toBeInstanceOf(BadRequestException);
    await expect(create).rejects.toThrow(message);
    expect(repo.save).not.toHaveBeenCalled();
  });

  // Two concurrent creates with one caller-supplied batchId both pass the existence read; the unique
  // index rejects the second, which must read as the same 400 as the sequential duplicate.
  it('answers a duplicate batchId that loses the insert race with the same 400', async () => {
    repo.save.mockRejectedValueOnce(
      Object.assign(new Error('UNIQUE constraint failed: message_batches.sessionId, message_batches.batchId'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      }),
    );
    const dto = {
      batchId: 'campaign-42',
      messages: [{ chatId: 'c0@c.us', type: 'text' as const, content: { text: 'hi' } }],
    } as unknown as SendBulkMessageDto;

    const create = service.createBatch('s1', dto);

    await expect(create).rejects.toBeInstanceOf(BadRequestException);
    await expect(create).rejects.toThrow("Batch ID 'campaign-42' already exists");
    expect((service as unknown as { inFlightBatches: number }).inFlightBatches).toBe(0);
  });

  it.each(['.', '..'])('rejects the dot-segment batchId %p, which no URL can address', async batchId => {
    const create = service.createBatch('s1', {
      batchId,
      messages: [{ chatId: 'c0@c.us', type: 'text', content: { text: 'hi' } }],
    } as unknown as SendBulkMessageDto);

    await expect(create).rejects.toBeInstanceOf(BadRequestException);
    await expect(create).rejects.toThrow(`Batch ID '${batchId}' is not allowed`);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('scopes the batchId uniqueness check to the session (no cross-session collision/oracle)', async () => {
    // Simulate a DB where batchId 'dup' exists only under session 's1'.
    repo.findOne.mockImplementation((opts: { where: { batchId?: string; sessionId?: string } }) => {
      const w = opts.where;
      const existsForS1 = w.batchId === 'dup' && (w.sessionId === undefined || w.sessionId === 's1');
      return Promise.resolve(existsForS1 ? { id: 'b1', batchId: 'dup', sessionId: 's1' } : undefined);
    });

    // A different session reusing the same batchId must succeed — the check is (batchId, sessionId)-scoped,
    // so it neither collides with another tenant's namespace nor leaks that the id is in use elsewhere.
    await expect(
      service.createBatch('s2', {
        messages: [{ chatId: 'c0@c.us', type: 'text', content: { text: 'hi' } }],
        batchId: 'dup',
      } as unknown as SendBulkMessageDto),
    ).resolves.toBeDefined();

    expect(repo.findOne).toHaveBeenCalledWith({ where: { batchId: 'dup', sessionId: 's2' } });
  });

  it('collapses exact duplicate entries before persisting (first occurrence wins, order preserved)', async () => {
    const dto = {
      messages: [
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'first' } },
        { chatId: 'b@c.us', type: 'text' as const, content: { text: 'second' } },
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'first' } }, // exact duplicate — dropped
      ],
    } as unknown as SendBulkMessageDto;

    const batch = await service.createBatch('s1', dto);

    expect(batch.messages.map(m => m.chatId)).toEqual(['a@c.us', 'b@c.us']);
    expect(batch.messages[0].content).toEqual({ text: 'first' }); // the first entry wins
    expect(batch.progress.total).toBe(2);
    expect(batch.progress.pending).toBe(2);
  });

  it('keeps distinct messages to the same chatId (different type/content/variables are not duplicates)', async () => {
    const dto = {
      messages: [
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'part 1' } },
        { chatId: 'a@c.us', type: 'image' as const, content: { image: { url: 'https://example.com/pic.jpg' } } },
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'part 1' }, variables: { name: 'x' } },
      ],
    } as unknown as SendBulkMessageDto;

    const batch = await service.createBatch('s1', dto);

    expect(batch.messages.map(m => m.type)).toEqual(['text', 'image', 'text']);
    expect(batch.progress.total).toBe(3);
    expect(batch.progress.pending).toBe(3);
  });

  it('runs the engine once per exact duplicate entry across the full create→process path', async () => {
    const engine = { sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa', timestamp: 1 }) };
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    const dto = {
      messages: [
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'first' } },
        { chatId: 'b@c.us', type: 'text' as const, content: { text: 'second' } },
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'first' } }, // exact duplicate — dropped
      ],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
    } as unknown as SendBulkMessageDto;

    const batch = await service.createBatch('s1', dto);
    // createBatch's own fire-and-forget processBatch saw no persisted row (findOne → undefined);
    // drive the processing explicitly with the created batch now "in the DB".
    repo.findOne.mockResolvedValue(batch);
    await (service as unknown as { processBatch: (id: string) => Promise<void> }).processBatch(batch.id);

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(engine.sendTextMessage).toHaveBeenNthCalledWith(1, 'a@c.us', 'first');
    expect(engine.sendTextMessage).toHaveBeenNthCalledWith(2, 'b@c.us', 'second');
  });

  it('sends every distinct message to the same chatId across the full create→process path', async () => {
    const engine = {
      sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa-t', timestamp: 1 }),
      sendImageMessage: jest.fn().mockResolvedValue({ id: 'wa-i', timestamp: 2 }),
    };
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    const dto = {
      messages: [
        { chatId: 'a@c.us', type: 'text' as const, content: { text: 'part 1' } },
        { chatId: 'a@c.us', type: 'image' as const, content: { image: { url: 'https://example.com/pic.jpg' } } },
      ],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
    } as unknown as SendBulkMessageDto;

    const batch = await service.createBatch('s1', dto);
    // Same fire-and-forget caveat as above — drive processing explicitly with the batch "in the DB".
    repo.findOne.mockResolvedValue(batch);
    await (service as unknown as { processBatch: (id: string) => Promise<void> }).processBatch(batch.id);

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(engine.sendTextMessage).toHaveBeenCalledWith('a@c.us', 'part 1');
    expect(engine.sendImageMessage).toHaveBeenCalledTimes(1);
    expect(batch.progress.sent).toBe(2);
    expect(batch.results).toHaveLength(2);
  });
});
