import { DataSource, Repository } from 'typeorm';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { clearDeliveryFailureRows, recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

const input = {
  webhookId: 'w',
  sessionId: 's',
  event: 'message.received',
  url: 'https://receiver.example',
  idempotencyKey: 'key',
  deliveryId: 'd',
  attempts: 3,
  lastStatusCode: 503,
  lastError: 'HTTP 503: down',
};

describe('webhook failure persistence', () => {
  let ds: DataSource;
  let second: DataSource;
  let directory: string;
  let repo: Repository<WebhookDeliveryFailure>;
  const logger = { error: jest.fn() };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'webhook-failures-'));
    const options = {
      type: 'better-sqlite3' as const,
      database: join(directory, 'data.sqlite'),
      entities: [WebhookDeliveryFailure],
    };
    ds = await new DataSource({ ...options, synchronize: true }).initialize();
    second = await new DataSource(options).initialize();
    repo = ds.getRepository(WebhookDeliveryFailure);
    logger.error.mockClear();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await second.destroy();
    await ds.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  it('parses HTTP status while leaving network errors unclassified', () => {
    expect(statusCodeFromError('HTTP 503: down')).toBe(503);
    expect(statusCodeFromError('fetch failed')).toBeNull();
  });
  it('keeps a terminal payload and updates attempts and the latest error on repeat', async () => {
    const payload = { body: 'private' };
    await expect(recordWebhookDeliveryFailure(repo, logger, { ...input, payload })).resolves.toBe(true);
    await expect(
      recordWebhookDeliveryFailure(repo, logger, {
        ...input,
        attempts: 1,
        lastStatusCode: 504,
        lastError: 'HTTP 504: timeout',
      }),
    ).resolves.toBe(false);
    const rows = await repo.find({
      select: { id: true, attempts: true, lastStatusCode: true, lastError: true, payload: true },
    });
    expect(rows).toEqual([
      expect.objectContaining({ attempts: 4, lastStatusCode: 504, lastError: 'HTTP 504: timeout', payload }),
    ]);
  });
  it('does not resurrect an expired payload when refreshing a terminal failure', async () => {
    await recordWebhookDeliveryFailure(repo, logger, input);
    await repo.update({ idempotencyKey: 'key' }, { payload: null, createdAt: new Date(Date.now() - 25 * 3600000) });
    await recordWebhookDeliveryFailure(repo, logger, { ...input, payload: { body: 'private' } });
    const row = await repo.findOneOrFail({ where: { idempotencyKey: 'key' }, select: { id: true, payload: true } });
    expect(row.payload).toBeNull();
  });

  // Recorded while payload retention was off, the row holds no event data; a later failure of the same delivery
  // carries it once retention is on, and the pending outbox copy is closed after that record.
  it('hands a later failure its event data to a terminal row recorded without it', async () => {
    await recordWebhookDeliveryFailure(repo, logger, input);
    await recordWebhookDeliveryFailure(repo, logger, {
      ...input,
      attempts: 1,
      payload: { body: 'kept' },
      payloadRetentionHours: 24,
    });
    const row = await repo.findOneOrFail({
      where: { idempotencyKey: 'key' },
      select: { id: true, attempts: true, payload: true },
    });
    expect(row).toMatchObject({ attempts: 4, payload: { body: 'kept' } });
  });

  it('hands no event data to a terminal row past the retention window', async () => {
    await recordWebhookDeliveryFailure(repo, logger, input);
    await repo.update({ idempotencyKey: 'key' }, { createdAt: new Date(Date.now() - 25 * 3600000) });
    await recordWebhookDeliveryFailure(repo, logger, {
      ...input,
      payload: { body: 'private' },
      payloadRetentionHours: 24,
    });
    const row = await repo.findOneOrFail({ where: { idempotencyKey: 'key' }, select: { id: true, payload: true } });
    expect(row.payload).toBeNull();
  });

  it('converges simultaneous recorders from two connections on one terminal identity', async () => {
    const results = await Promise.all([
      recordWebhookDeliveryFailure(repo, logger, input),
      recordWebhookDeliveryFailure(second.getRepository(WebhookDeliveryFailure), logger, { ...input, attempts: 1 }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await repo.count()).toBe(1);
    expect((await repo.findOneByOrFail({ idempotencyKey: 'key' })).attempts).toBe(4);
  });
  it('replaces an unattempted row only after the terminal row is stored', async () => {
    await recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0, payload: { body: 'unused' } });
    await recordWebhookDeliveryFailure(repo, logger, { ...input, payload: { body: 'retained' } });
    expect(await repo.count()).toBe(1);
    expect((await repo.findOneByOrFail({ idempotencyKey: 'key' })).attempts).toBe(3);
  });
  it('keeps an unattempted row when terminal persistence fails', async () => {
    await recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0 });
    jest.spyOn(repo, 'insert').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(recordWebhookDeliveryFailure(repo, logger, input)).resolves.toBeNull();
    expect((await repo.findOneByOrFail({ idempotencyKey: 'key' })).attempts).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });
  it('returns a persistence failure when refreshing a terminal row fails', async () => {
    await recordWebhookDeliveryFailure(repo, logger, input);
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(recordWebhookDeliveryFailure(repo, logger, input)).resolves.toBeNull();
  });
  it('removes an unattempted row that an earlier terminal record left behind', async () => {
    // A crash, or a failed delete, right after the terminal insert leaves both rows. Nothing else
    // reconciles the unattempted one, so every repeat of the terminal record finishes the clean-up.
    await recordWebhookDeliveryFailure(repo, logger, input);
    await repo.insert({ ...input, attempts: 0, lastStatusCode: null, lastError: 'ConcurrencyLimiter closed' });

    await expect(recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 1 })).resolves.toBe(false);

    expect(await repo.count({ where: { attempts: 0 } })).toBe(0);
    expect((await repo.findOneByOrFail({ idempotencyKey: 'key' })).attempts).toBe(4);
  });
  it('still reports an unattempted duplicate as not recorded when refreshing its reason fails', async () => {
    // A true here would count a loss that is already counted.
    await recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0 });
    jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(
      recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0, lastError: 'too large' }),
    ).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to refresh the reason of an unsent webhook delivery',
      'disk unavailable',
      expect.objectContaining({ action: 'webhook_failure_record_error' }),
    );
    expect((await repo.findOneByOrFail({ idempotencyKey: 'key' })).lastError).toBe('HTTP 503: down');
  });
  it('records unkeyed losses separately and stores no replay payload by default', async () => {
    await recordWebhookDeliveryFailure(repo, logger, { ...input, idempotencyKey: undefined });
    await recordWebhookDeliveryFailure(repo, logger, { ...input, idempotencyKey: undefined });
    expect(await repo.count()).toBe(2);
    const rows = await repo.find({ select: { id: true, payload: true } });
    expect(rows.every(r => r.payload === null)).toBe(true);
  });
  it('never keeps a payload on an unattempted row and refreshes its refusal reason', async () => {
    await recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0, payload: { body: 'unused' } });
    await recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0, lastError: 'too large' });
    const row = await repo.findOneOrFail({
      where: { idempotencyKey: 'key' },
      select: { id: true, lastError: true, payload: true },
    });
    expect(row).toMatchObject({ lastError: 'too large', payload: null });
  });
  it('clears only the matching identity and never deletes every row for an unkeyed loss', async () => {
    await recordWebhookDeliveryFailure(repo, logger, input);
    await recordWebhookDeliveryFailure(repo, logger, { ...input, idempotencyKey: 'other' });
    await clearDeliveryFailureRows(repo, logger, 'w', undefined);
    expect(await repo.count()).toBe(2);
    await clearDeliveryFailureRows(repo, logger, 'w', 'key');
    expect(await repo.count()).toBe(1);
  });
  it('logs a failed clear without changing the delivery outcome', async () => {
    jest.spyOn(repo, 'delete').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(clearDeliveryFailureRows(repo, logger, 'w', 'key')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
