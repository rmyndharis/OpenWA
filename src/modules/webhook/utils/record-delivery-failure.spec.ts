import { MoreThan, Repository } from 'typeorm';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { clearDeliveryFailureRows, recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

describe('statusCodeFromError', () => {
  it('parses the status from an "HTTP <code>: ..." message', () => {
    expect(statusCodeFromError('HTTP 503: Service Unavailable')).toBe(503);
    expect(statusCodeFromError('HTTP 404: Not Found')).toBe(404);
  });

  it('returns null for a non-HTTP error (network / timeout / SSRF)', () => {
    expect(statusCodeFromError('The operation was aborted due to timeout')).toBeNull();
    expect(statusCodeFromError('fetch failed')).toBeNull();
  });
});

describe('recordWebhookDeliveryFailure', () => {
  const input = {
    webhookId: 'wh-1',
    sessionId: 's1',
    event: 'message.received',
    url: 'https://r.example/h',
    idempotencyKey: 'k',
    deliveryId: 'd',
    attempts: 3,
    lastStatusCode: 503,
    lastError: 'HTTP 503: x',
  };

  const repoWith = (insert: jest.Mock, existing = 0): Repository<WebhookDeliveryFailure> =>
    ({
      insert,
      count: jest.fn().mockResolvedValue(existing),
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    }) as unknown as Repository<WebhookDeliveryFailure>;

  it('inserts the failure record, defaulting a missing lastStatusCode to null', async () => {
    const insert = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await expect(
      recordWebhookDeliveryFailure(repoWith(insert), logger, { ...input, lastStatusCode: undefined }),
    ).resolves.toBe(true);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ webhookId: 'wh-1', lastStatusCode: null }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips a delivery it has already recorded, so one lost event is one row', async () => {
    // The reconciler replays a stranded delivery once per sweep until its budget is spent, and each
    // failed replay lands here with the SAME idempotency key.
    const insert = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repoWith(insert, 1), logger, input)).resolves.toBe(false);

    expect(insert).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('gives the attempts-0 row the reason of an unsent delivery recorded again, without a second row', async () => {
    // A shed delivery whose replay then fails before sending: the operator has to act on the new
    // reason, not on the shed. Only attempts-0 rows take it, and the metric does not count it again.
    const insert = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = {
      insert,
      update,
      count: jest.fn().mockResolvedValue(1),
    } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(
      recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0, lastStatusCode: null, lastError: 'too big' }),
    ).resolves.toBe(false);

    expect(insert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      { webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 },
      { lastError: 'too big', url: 'https://r.example/h', deliveryId: 'd' },
    );
  });

  it('leaves the recorded row alone for a terminal failure recorded again', async () => {
    const update = jest.fn();
    const repo = {
      insert: jest.fn(),
      update,
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    } as unknown as Repository<WebhookDeliveryFailure>;

    await expect(recordWebhookDeliveryFailure(repo, { error: jest.fn() }, input)).resolves.toBe(false);

    expect(update).not.toHaveBeenCalled();
  });

  it('removes an attempts-0 row an earlier terminal record failed to clear', async () => {
    // The first terminal record inserted its row, then its attempts-0 delete failed (or the process
    // stopped in between). The next replay finds the terminal row, and must finish that clear, or
    // the lost event stays listed twice.
    const insert = jest.fn();
    const del = jest.fn().mockResolvedValue({});
    const repo = {
      insert,
      update: jest.fn(),
      delete: del,
      count: jest.fn().mockResolvedValue(1),
    } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repo, logger, input)).resolves.toBe(false);

    expect(insert).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('removes nothing when an unsent delivery is recorded again', async () => {
    const del = jest.fn();
    const repo = {
      insert: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: del,
      count: jest.fn().mockResolvedValue(1),
    } as unknown as Repository<WebhookDeliveryFailure>;

    await expect(recordWebhookDeliveryFailure(repo, { error: jest.fn() }, { ...input, attempts: 0 })).resolves.toBe(
      false,
    );

    expect(del).not.toHaveBeenCalled();
  });

  it('still reports an unsent duplicate as not recorded when refreshing its reason fails', async () => {
    // A true here would bump the failure metric for a loss that is already counted.
    const repo = {
      insert: jest.fn(),
      update: jest.fn().mockRejectedValue(new Error('db down')),
      count: jest.fn().mockResolvedValue(1),
    } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0 })).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('still records a failure that carries no idempotency key', async () => {
    // Control: without a key there is no identity to dedupe on, so the guard must not swallow the
    // row. Otherwise "skips a duplicate" would be satisfied by a helper that stopped inserting.
    const insert = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await expect(
      recordWebhookDeliveryFailure(repoWith(insert, 1), logger, { ...input, idempotencyKey: undefined }),
    ).resolves.toBe(true);

    expect(insert).toHaveBeenCalled();
  });

  it('dedupes a terminal row only against terminal rows, then removes the attempts-0 row it replaces', async () => {
    // A shed or shutdown-refused dispatch left an attempts-0 row. Counted as a duplicate, it would
    // keep the capacity reason as the only record and drop the receiver's actual answer.
    const calls: string[] = [];
    const insert = jest.fn().mockImplementation(() => (calls.push('insert'), Promise.resolve({})));
    const count = jest.fn().mockResolvedValue(0);
    const del = jest.fn().mockImplementation(() => (calls.push('delete'), Promise.resolve({})));
    const repo = { insert, count, delete: del } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repo, logger, input)).resolves.toBe(true);

    expect(count).toHaveBeenCalledWith({
      where: { webhookId: 'wh-1', idempotencyKey: 'k', attempts: MoreThan(0) },
    });
    expect(del).toHaveBeenCalledWith({ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 });
    // Written first, so a crash in between leaves two rows for the event rather than none.
    expect(calls).toEqual(['insert', 'delete']);
  });

  it('dedupes an attempts-0 row against every row of the delivery and removes nothing', async () => {
    const insert = jest.fn().mockResolvedValue({});
    const count = jest.fn().mockResolvedValue(0);
    const del = jest.fn().mockResolvedValue({});
    const repo = { insert, count, delete: del } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repo, logger, { ...input, attempts: 0 })).resolves.toBe(true);

    expect(count).toHaveBeenCalledWith({ where: { webhookId: 'wh-1', idempotencyKey: 'k' } });
    expect(del).not.toHaveBeenCalled();
  });

  it('keeps the terminal row and the result when removing the attempts-0 row fails', async () => {
    const insert = jest.fn().mockResolvedValue({});
    const repo = {
      insert,
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repo, logger, input)).resolves.toBe(true);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      'db down',
      expect.objectContaining({ action: 'webhook_failure_clear_error' }),
    );
  });

  it('swallows a repository error so a logging hiccup cannot re-poison the delivery', async () => {
    const insert = jest.fn().mockRejectedValue(new Error('db down'));
    const logger = { error: jest.fn() };

    // Reported as recorded even though the row was lost: the delivery really did fail, and the
    // caller's failure metric must count it rather than hide it behind a database problem.
    await expect(recordWebhookDeliveryFailure(repoWith(insert), logger, input)).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('clearDeliveryFailureRows', () => {
  const repoWithDelete = (del: jest.Mock): Repository<WebhookDeliveryFailure> =>
    ({ delete: del }) as unknown as Repository<WebhookDeliveryFailure>;

  it('deletes every row of one delivery, or only its attempts-0 rows', async () => {
    const del = jest.fn().mockResolvedValue({});
    const logger = { error: jest.fn() };

    await clearDeliveryFailureRows(repoWithDelete(del), logger, 'wh-1', 'k');
    await clearDeliveryFailureRows(repoWithDelete(del), logger, 'wh-1', 'k', true);

    expect(del.mock.calls).toEqual([
      [{ webhookId: 'wh-1', idempotencyKey: 'k' }],
      [{ webhookId: 'wh-1', idempotencyKey: 'k', attempts: 0 }],
    ]);
  });

  it('deletes nothing without an idempotency key', async () => {
    // Matching on webhookId alone would erase the rows of every other lost event of that webhook.
    const del = jest.fn().mockResolvedValue({});

    await clearDeliveryFailureRows(repoWithDelete(del), { error: jest.fn() }, 'wh-1', undefined);

    expect(del).not.toHaveBeenCalled();
  });

  it('logs a failed delete instead of throwing', async () => {
    const logger = { error: jest.fn() };

    await expect(
      clearDeliveryFailureRows(repoWithDelete(jest.fn().mockRejectedValue(new Error('db down'))), logger, 'wh-1', 'k'),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
