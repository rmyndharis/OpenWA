import { isMessagePayload, isWebhookBeforeResult } from './hook-results';

describe('hook result checks', () => {
  it('accepts a message payload only when it carries both a string id and a string chatId', () => {
    expect(isMessagePayload({ id: 'm', chatId: 'c@c.us' })).toBe(true);
    expect(isMessagePayload({ id: 'm' })).toBe(false);
    expect(isMessagePayload({ chatId: 'c@c.us' })).toBe(false);
    expect(isMessagePayload({ id: 1, chatId: 'c@c.us' })).toBe(false);
    expect(isMessagePayload({ id: 'm', chatId: 2 })).toBe(false);
    expect(isMessagePayload(null)).toBe(false);
    expect(isMessagePayload(['m', 'c'])).toBe(false);
    expect(isMessagePayload('m')).toBe(false);
  });

  it('accepts a webhook:before result only when it carries an own plain-object payload', () => {
    expect(isWebhookBeforeResult({ payload: { a: 1 } })).toBe(true);
    expect(
      isWebhookBeforeResult({ payload: Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }) }),
    ).toBe(true);
    expect(isWebhookBeforeResult({ payload: null })).toBe(false);
    expect(isWebhookBeforeResult({ payload: [1] })).toBe(false);
    expect(isWebhookBeforeResult({ payload: new Date('2026-01-01T00:00:00Z') })).toBe(false);
    expect(isWebhookBeforeResult({ payload: new Map() })).toBe(false);
    expect(isWebhookBeforeResult({ payload: new Set() })).toBe(false);
    expect(isWebhookBeforeResult({ payload: /re/ })).toBe(false);
    expect(isWebhookBeforeResult(Object.create({ payload: { a: 1 } }))).toBe(false);
    expect(isWebhookBeforeResult({})).toBe(false);
    expect(isWebhookBeforeResult(null)).toBe(false);
  });
});
