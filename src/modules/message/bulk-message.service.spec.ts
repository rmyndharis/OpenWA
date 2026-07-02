import { Test, TestingModule } from '@nestjs/testing';
import { PayloadTooLargeException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BulkMessageService, resolveFinalBatchStatus, sanitizeBatchError } from './bulk-message.service';
import { MessageBatch, BatchStatus } from './entities/message-batch.entity';
import { MessageStatus } from './entities/message.entity';
import { SendBulkMessageDto } from './dto/bulk-message.dto';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
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
        { provide: SessionService, useValue: { getEngine: jest.fn() } },
        { provide: MessageService, useValue: { saveOutgoingMessage: jest.fn() } },
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
});

describe('BulkMessageService.processBatch', () => {
  let service: BulkMessageService;
  let repo: { findOne: jest.Mock; save: jest.Mock };
  let messageService: { saveOutgoingMessage: jest.Mock };
  let engine: {
    sendTextMessage: jest.Mock;
    sendImageMessage?: jest.Mock;
    sendVideoMessage?: jest.Mock;
    sendAudioMessage?: jest.Mock;
  };
  let sessionService: { getEngine: jest.Mock; findOne: jest.Mock };

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
    sessionService = {
      getEngine: jest.fn().mockReturnValue(engine),
      findOne: jest.fn().mockResolvedValue({ phone: '628' }),
    };
    messageService = { saveOutgoingMessage: jest.fn().mockResolvedValue(undefined) };
    repo = { findOne: jest.fn(), save: jest.fn().mockImplementation(b => Promise.resolve(b)) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        { provide: SessionService, useValue: sessionService },
        { provide: MessageService, useValue: messageService },
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
    sessionService.getEngine.mockReturnValue(undefined); // engine-not-found → early-return path

    await runProcessBatch();

    expect(inFlightMarkers().has('b1')).toBe(false);
  });

  it('releases the in-flight marker when processing throws (no processingBatches leak)', async () => {
    repo.findOne.mockResolvedValue(makeBatch(1));
    repo.save.mockRejectedValueOnce(new Error('db down')); // the first save (→ PROCESSING) throws

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

    // A completed batch is terminal (never resumed), so the persisted message_batches.messages must not
    // retain the (often multi-MB) base64 — only the descriptive fields are kept.
    const savedBatch = (repo.save.mock.calls as [MessageBatch][]).at(-1)![0];
    const img = (savedBatch.messages[0].content as { image?: { base64?: unknown; mimetype?: string } }).image;
    expect(img?.base64).toBeUndefined();
    expect(img?.mimetype).toBe('image/png');
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
    // First load is the running batch; the cadence re-read reports a CANCELLED status.
    repo.findOne.mockResolvedValueOnce(makeBatch(3)).mockResolvedValue({ status: BatchStatus.CANCELLED });

    await runProcessBatch();

    // Only the first message (before the cadence re-read saw CANCELLED) was sent.
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('does not clobber a CANCELLED that landed after the last cadence read (final status stays CANCELLED)', async () => {
    const batch = makeBatch(1);
    repo.findOne
      .mockResolvedValueOnce(batch) // processBatch initial load
      .mockResolvedValueOnce(batch) // cadence re-read (i=0) — still PROCESSING
      .mockResolvedValue({ status: BatchStatus.CANCELLED }); // FINAL pre-save re-read — cancel landed late

    await runProcessBatch();

    const savedStatuses = (repo.save.mock.calls as [MessageBatch][]).map(c => c[0].status);
    expect(savedStatuses[savedStatuses.length - 1]).toBe(BatchStatus.CANCELLED);
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
});

describe('BulkMessageService.createBatch base64 media cap', () => {
  let service: BulkMessageService;
  let repo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockImplementation(b => Promise.resolve(b)),
      create: jest.fn().mockImplementation((b: MessageBatch) => b),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkMessageService,
        { provide: getRepositoryToken(MessageBatch, 'data'), useValue: repo },
        { provide: SessionService, useValue: { getEngine: jest.fn().mockReturnValue({}) } },
        { provide: MessageService, useValue: { saveOutgoingMessage: jest.fn() } },
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
});
