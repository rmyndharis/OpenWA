import { Repository } from 'typeorm';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './record-delivery-failure';

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

  it('inserts the failure record, defaulting a missing lastStatusCode to null', async () => {
    const insert = jest.fn().mockResolvedValue({});
    const repo = { insert } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await recordWebhookDeliveryFailure(repo, logger, { ...input, lastStatusCode: undefined });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ webhookId: 'wh-1', lastStatusCode: null }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a repository error so a logging hiccup cannot re-poison the delivery', async () => {
    const insert = jest.fn().mockRejectedValue(new Error('db down'));
    const repo = { insert } as unknown as Repository<WebhookDeliveryFailure>;
    const logger = { error: jest.fn() };

    await expect(recordWebhookDeliveryFailure(repo, logger, input)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
