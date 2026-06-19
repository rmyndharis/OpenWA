import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BulkMessageService, resolveFinalBatchStatus, sanitizeBatchError } from './bulk-message.service';
import { MessageBatch, BatchStatus } from './entities/message-batch.entity';
import { MessageStatus } from './entities/message.entity';
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
  let engine: { sendTextMessage: jest.Mock };
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
});
