import { DataSource, Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import {
  PendingMessageReaperService,
  PendingMessageReaperOptions,
  resolvePendingMessageReaperOptions,
} from './pending-message-reaper.service';
import { HookManager } from '../../core/hooks';

const OPTS: PendingMessageReaperOptions = { intervalMs: 600_000, graceMs: 3_600_000, batchSize: 50 };

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);
const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

describe('PendingMessageReaperService.sweep', () => {
  let ds: DataSource;
  let messages: Repository<Message>;
  let execute: jest.Mock;
  let service: PendingMessageReaperService;
  let seq: number;

  beforeEach(async () => {
    seq = 0;
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    });
    await ds.initialize();
    messages = ds.getRepository(Message);
    execute = jest.fn().mockResolvedValue(undefined);
    service = new PendingMessageReaperService(messages, { execute } as unknown as HookManager);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    if (ds.isInitialized) await ds.destroy();
  });

  // queryBuilder insert (not repo.save) so createdAt is set explicitly and the test controls the
  // grace window rather than the @CreateDateColumn "now" default.
  const insertMessage = async (over: Record<string, unknown> = {}): Promise<string> => {
    const n = ++seq;
    await messages
      .createQueryBuilder()
      .insert()
      .values({
        id: `msg-${n}`,
        sessionId: 'sess-1',
        chatId: '628123@c.us',
        from: 'me',
        to: '628123@c.us',
        body: `hello ${n}`,
        type: 'text',
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.PENDING,
        createdAt: hoursAgo(2),
        ...over,
      })
      .execute();
    return `msg-${n}`;
  };
  const stored = (id: string) => messages.findOneByOrFail({ id });
  const persistedCalls = () =>
    execute.mock.calls.filter(([event]) => event === 'message:persisted') as Array<
      [string, { sessionId: string; message: Message }, { sessionId: string; source: string }]
    >;

  it('fails a stale outgoing PENDING row, marks it reapedAt, and emits message:persisted', async () => {
    const id = await insertMessage();

    const stats = await service.sweep(OPTS);

    expect(stats).toEqual({ scanned: 1, reaped: 1, failed: 0 });
    const row = await stored(id);
    expect(row.status).toBe(MessageStatus.FAILED);
    expect(typeof (row.metadata as { reapedAt?: string }).reapedAt).toBe('string');

    expect(persistedCalls()).toHaveLength(1);
    const [event, payload, context] = persistedCalls()[0];
    expect(event).toBe('message:persisted');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.message.id).toBe(id);
    expect(payload.message.status).toBe(MessageStatus.FAILED);
    expect((payload.message.metadata as { reapedAt?: string }).reapedAt).toBeDefined();
    expect(context).toEqual({ sessionId: 'sess-1', source: 'PendingMessageReaperService' });
  });

  it('does not touch an outgoing PENDING row younger than the grace window', async () => {
    const id = await insertMessage({ createdAt: minutesAgo(10) });

    const stats = await service.sweep(OPTS);

    expect(stats).toEqual({ scanned: 0, reaped: 0, failed: 0 });
    expect((await stored(id)).status).toBe(MessageStatus.PENDING);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never touches outgoing rows that already reached a post-pending state', async () => {
    const sent = await insertMessage({ status: MessageStatus.SENT });
    const failed = await insertMessage({ status: MessageStatus.FAILED });

    const stats = await service.sweep(OPTS);

    expect(stats).toEqual({ scanned: 0, reaped: 0, failed: 0 });
    expect((await stored(sent)).status).toBe(MessageStatus.SENT);
    expect((await stored(failed)).status).toBe(MessageStatus.FAILED);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never touches incoming rows, even a stale PENDING one', async () => {
    const id = await insertMessage({ direction: MessageDirection.INCOMING });

    const stats = await service.sweep(OPTS);

    expect(stats).toEqual({ scanned: 0, reaped: 0, failed: 0 });
    expect((await stored(id)).status).toBe(MessageStatus.PENDING);
    expect(execute).not.toHaveBeenCalled();
  });

  it('bounds the sweep to the batch size, oldest first, and drains the rest on the next pass', async () => {
    const ids: string[] = [];
    for (const age of [5, 4, 3, 2, 1.5]) ids.push(await insertMessage({ createdAt: hoursAgo(age) }));
    const tight = { ...OPTS, batchSize: 3 };

    const first = await service.sweep(tight);

    expect(first).toEqual({ scanned: 3, reaped: 3, failed: 0 });
    for (const id of ids.slice(0, 3)) expect((await stored(id)).status).toBe(MessageStatus.FAILED);
    for (const id of ids.slice(3)) expect((await stored(id)).status).toBe(MessageStatus.PENDING);
    expect(persistedCalls()).toHaveLength(3);

    const second = await service.sweep(tight);
    expect(second).toEqual({ scanned: 2, reaped: 2, failed: 0 });
    for (const id of ids) expect((await stored(id)).status).toBe(MessageStatus.FAILED);
  });

  it('drops the outbound media payload on reap but keeps mimetype/filename and other metadata', async () => {
    const id = await insertMessage({
      type: 'image',
      metadata: { media: { mimetype: 'image/jpeg', filename: 'a.jpg', data: 'aGVsbG8=' }, quotedMessage: { id: 'q1' } },
    });

    await service.sweep(OPTS);

    const metadata = (await stored(id)).metadata as {
      media: { mimetype?: string; filename?: string; data?: string };
      quotedMessage: { id: string };
      reapedAt: string;
    };
    expect(metadata.media.data).toBeUndefined();
    expect(metadata.media.mimetype).toBe('image/jpeg');
    expect(metadata.media.filename).toBe('a.jpg');
    expect(metadata.quotedMessage).toEqual({ id: 'q1' });
    expect(metadata.reapedAt).toBeDefined();
    // The emitted snapshot carries the same slimmed metadata.
    const [, payload] = persistedCalls()[0];
    expect((payload.message.metadata as { media: { data?: string } }).media.data).toBeUndefined();
  });

  it('keeps the batch alive when one row fails to persist', async () => {
    const first = await insertMessage();
    const second = await insertMessage();
    const updateSpy = jest.spyOn(messages, 'update').mockRejectedValueOnce(new Error('db hiccup'));

    const stats = await service.sweep(OPTS);

    expect(stats).toEqual({ scanned: 2, reaped: 1, failed: 1 });
    expect((await stored(first)).status).toBe(MessageStatus.PENDING);
    expect((await stored(second)).status).toBe(MessageStatus.FAILED);
    expect(persistedCalls()).toHaveLength(1);
    updateSpy.mockRestore();
  });

  it('does not overwrite a row whose send resolved between the sweep read and the reap write', async () => {
    const id = await insertMessage();
    const realUpdate = messages.update.bind(messages);
    // The live send path persists its own SENT + waMessageId outcome just before the reap write
    // lands; the guarded UPDATE must then match nothing instead of clobbering it back to FAILED.
    jest.spyOn(messages, 'update').mockImplementationOnce(async (criteria, partial) => {
      await realUpdate({ id }, { status: MessageStatus.SENT, waMessageId: 'wamid.race' });
      return realUpdate(criteria, partial);
    });

    const stats = await service.sweep(OPTS);

    expect(stats).toEqual({ scanned: 1, reaped: 0, failed: 0 });
    const row = await stored(id);
    expect(row.status).toBe(MessageStatus.SENT);
    expect(row.waMessageId).toBe('wamid.race');
    expect(persistedCalls()).toHaveLength(0);
  });
});

describe('resolvePendingMessageReaperOptions', () => {
  it('defaults to a 10-minute interval, 1-hour grace, and a batch of 50', () => {
    expect(resolvePendingMessageReaperOptions({})).toEqual({
      intervalMs: 600_000,
      graceMs: 3_600_000,
      batchSize: 50,
    });
  });

  it('reads interval, grace, and batch size from the environment', () => {
    expect(
      resolvePendingMessageReaperOptions({
        MESSAGE_REAPER_INTERVAL_MS: '300000',
        MESSAGE_REAPER_GRACE_MS: '120000',
        MESSAGE_REAPER_BATCH_SIZE: '7',
      }),
    ).toEqual({ intervalMs: 300_000, graceMs: 120_000, batchSize: 7 });
  });

  it('falls back to defaults on non-numeric or out-of-range values', () => {
    expect(
      resolvePendingMessageReaperOptions({
        MESSAGE_REAPER_INTERVAL_MS: 'abc',
        MESSAGE_REAPER_GRACE_MS: '-5',
        MESSAGE_REAPER_BATCH_SIZE: '0',
      }),
    ).toEqual({ intervalMs: 600_000, graceMs: 3_600_000, batchSize: 50 });
  });

  it('treats blank values as unset, not as 0 (which would disable the reaper)', () => {
    expect(
      resolvePendingMessageReaperOptions({
        MESSAGE_REAPER_INTERVAL_MS: '',
        MESSAGE_REAPER_GRACE_MS: '   ',
      }),
    ).toEqual({ intervalMs: 600_000, graceMs: 3_600_000, batchSize: 50 });
  });
});

describe('PendingMessageReaperService.onModuleInit (scheduling)', () => {
  const ENV_KEYS = ['MESSAGE_REAPER_INTERVAL_MS', 'MESSAGE_REAPER_GRACE_MS', 'MESSAGE_REAPER_BATCH_SIZE'] as const;
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originals.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originals.clear();
  });

  const makeService = () =>
    new PendingMessageReaperService(
      { find: jest.fn() } as unknown as Repository<Message>,
      { execute: jest.fn() } as unknown as HookManager,
    );

  it('does not schedule a timer when MESSAGE_REAPER_INTERVAL_MS <= 0', () => {
    process.env.MESSAGE_REAPER_INTERVAL_MS = '0';
    const svc = makeService();

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(svc, 'sweep');
      svc.onModuleInit();
      jest.advanceTimersByTime(10 * 600_000);
      expect(sweepSpy).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sweeps on the configured interval and stops after onModuleDestroy', () => {
    process.env.MESSAGE_REAPER_INTERVAL_MS = '60000';
    const svc = makeService();

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(svc, 'sweep').mockResolvedValue({ scanned: 0, reaped: 0, failed: 0 });
      svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      svc.onModuleDestroy();
      sweepSpy.mockClear();
      jest.advanceTimersByTime(60_000);
      expect(sweepSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
