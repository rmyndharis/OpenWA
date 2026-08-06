import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, PayloadTooLargeException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Not } from 'typeorm';
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
  let repo: { find: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
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

    expect(repo.find).toHaveBeenCalledWith({ where: { status: BatchStatus.PROCESSING } });
    expect(batch.status).toBe(BatchStatus.FAILED);
    expect(repo.save).toHaveBeenCalledWith(batch);
  });

  it('does nothing when there are no orphaned batches', async () => {
    repo.find.mockResolvedValue([]);
    await service.onApplicationBootstrap();
    expect(repo.save).not.toHaveBeenCalled();
  });

  /**
   * The takeover path's reconcile: adopting a session from a lapsed node must fail THAT session's
   * stuck batches (same no-auto-resume policy as boot — the dead node's already-sent messages are
   * unknowable), scoped strictly to the one session, with inline media payloads stripped.
   */
  it('reapProcessingBatches fails only the given session’s PROCESSING batches and strips payloads', async () => {
    const mine = {
      id: 'b1',
      sessionId: 'sess-a',
      status: BatchStatus.PROCESSING,
      messages: [{ content: { image: { base64: 'x'.repeat(64) } } }],
    } as unknown as MessageBatch;
    repo.find.mockResolvedValue([mine]);

    const reaped = await service.reapProcessingBatches('sess-a', 'session adopted from a lapsed node');

    expect(repo.find).toHaveBeenCalledWith({ where: { status: BatchStatus.PROCESSING, sessionId: 'sess-a' } });
    expect(reaped).toBe(1);
    expect(mine.status).toBe(BatchStatus.FAILED);
    expect(repo.save).toHaveBeenCalledWith(mine);
    expect(JSON.stringify(mine.messages)).not.toContain('x'.repeat(64));
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

      expect(peers.status).toBe(BatchStatus.PROCESSING);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('still reaps a batch whose session this node may claim', async () => {
      const mine = { id: 'b2', sessionId: 'my-session', status: BatchStatus.PROCESSING } as MessageBatch;
      repo.find.mockResolvedValue([mine]);

      await (await withOwnership(['my-session'])).onApplicationBootstrap();

      expect(mine.status).toBe(BatchStatus.FAILED);
      expect(repo.save).toHaveBeenCalledWith(mine);
    });

    it('reaps only its own when both are present', async () => {
      const mine = { id: 'b2', sessionId: 'my-session', status: BatchStatus.PROCESSING } as MessageBatch;
      const peers = { id: 'b1', sessionId: 'peer-session', status: BatchStatus.PROCESSING } as MessageBatch;
      repo.find.mockResolvedValue([mine, peers]);

      await (await withOwnership(['my-session'])).onApplicationBootstrap();

      expect(mine.status).toBe(BatchStatus.FAILED);
      expect(peers.status).toBe(BatchStatus.PROCESSING);
      expect(repo.save).toHaveBeenCalledTimes(1);
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
    engine = { sendTextMessage: jest.fn().mockResolvedValue({ id: 'wa1', timestamp: 111 }) };
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

  it('rejects a new batch (before persisting) when the concurrent in-flight cap is reached', async () => {
    const prev = process.env.BULK_MAX_CONCURRENT_BATCHES;
    process.env.BULK_MAX_CONCURRENT_BATCHES = '2';
    try {
      repo.findOne.mockResolvedValue(null); // batchId not taken
      (service as unknown as { inFlightBatches: number }).inFlightBatches = 2; // at cap
      const dto = { messages: [{ chatId: 'c@c.us', type: 'text', content: { text: 'hi' } }] };
      await expect(service.createBatch('s1', dto as never)).rejects.toThrow(/too many bulk batches/i);
      expect(repo.save).not.toHaveBeenCalled(); // rejected before a PENDING row is written
    } finally {
      if (prev === undefined) delete process.env.BULK_MAX_CONCURRENT_BATCHES;
      else process.env.BULK_MAX_CONCURRENT_BATCHES = prev;
    }
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

  it('runs the message:sending gate for each bulk message (bulk no longer bypasses moderation)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));

    await runProcessBatch();

    expect(hookManager.execute).toHaveBeenCalledWith(
      'message:sending',
      expect.objectContaining({ type: 'text', sessionId: 's1' }),
      expect.objectContaining({ source: 'BulkMessageService' }),
    );
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
      expect.objectContaining({ type: 'text', error: 'boom' }),
      expect.objectContaining({ source: 'BulkMessageService' }),
    );
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
    // the last guarded UPDATE (start transition and cadence writes carry no messages payload).
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
    repo.findOne.mockResolvedValue(makeBatch(3));
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition → PROCESSING
      .mockResolvedValueOnce({ affected: 0 }) // cadence write at i=0 loses to the committed CANCELLED
      .mockResolvedValue({ affected: 1 });

    await runProcessBatch();

    // Only the first message (before the guarded cadence write saw the cancel) was sent.
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    // The terminal write persists CANCELLED with reconciled counters — never a PROCESSING rewrite.
    const savedBatch = (repo.save.mock.calls as [MessageBatch][]).at(-1)![0];
    expect(savedBatch.status).toBe(BatchStatus.CANCELLED);
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

  it('sends nothing when a cancel commits between pickup and the guarded start transition', async () => {
    repo.findOne.mockResolvedValue(makeBatch(3));
    repo.update.mockResolvedValueOnce({ affected: 0 }); // CANCELLED won the race to the first write

    await runProcessBatch();

    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledTimes(1); // the guarded start transition only
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'b1', status: Not(BatchStatus.CANCELLED) },
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
    const savedBatch = (repo.save.mock.calls as [MessageBatch][]).at(-1)![0];
    expect(savedBatch.status).toBe(BatchStatus.CANCELLED);
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
      .mockResolvedValueOnce({ status: BatchStatus.PROCESSING }); // pre-final re-read — cancel not visible yet
    repo.update
      .mockResolvedValueOnce({ affected: 1 }) // start transition → PROCESSING
      .mockResolvedValueOnce({ affected: 1 }) // cadence write (i=0, also the last item)
      .mockResolvedValueOnce({ affected: 0 }); // final write loses the race to a committed CANCELLED

    await runProcessBatch();

    expect(batch.status).toBe(BatchStatus.CANCELLED); // terminal state follows the DB, not the runner
    expect(repo.save).not.toHaveBeenCalled(); // no unguarded terminal write happened
    const finalCriteria = (repo.update.mock.calls as Array<[unknown, unknown]>).at(-1)![0];
    expect(finalCriteria).toEqual({ id: 'b1', status: Not(BatchStatus.CANCELLED) });
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
      messages: [{ chatId: 'c0@c.us', type: 'text' as const, content: { text: { body: 'hi' } } }],
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
      messages: [{ chatId: 'c0@c.us', type: 'text' as const, content: { text: { body: 'hi' } } }],
    } as unknown as SendBulkMessageDto;

    await expect(service.createBatch('s1', dto)).rejects.toThrow('database unavailable');

    expect((service as unknown as { inFlightBatches: number }).inFlightBatches).toBe(0);
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
        messages: [{ chatId: 'c0@c.us', type: 'text', content: { text: { body: 'hi' } } }],
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
