import { Headers } from 'undici';
import {
  buildDeliveryHeaders,
  generateSignature,
  isDeliverableWebhook,
  postWebhookPayload,
  sanitizeCustomHeaders,
} from './deliver-once';

/**
 * Direct coverage for the shared delivery core both paths (direct and queued processor) now route
 * through. Previously each path carried its own line-for-line copy of the POST + classification,
 * which is the duplication an outbox would have tripled.
 */
describe('postWebhookPayload', () => {
  const makeFetch = (status = 200): { mock: jest.Mock } => ({
    mock: jest.fn().mockResolvedValue({ ok: status < 400, status, statusText: 'OK' }),
  });

  it('POSTs the exact body bytes with the given headers and timeout, through the SSRF guard', async () => {
    const { mock } = makeFetch();
    await postWebhookPayload('https://receiver.example/hook', '{"a":1}', { 'X-Test': '1' }, 5000, mock as never);

    const calls = mock.mock.calls as unknown as unknown[][];
    const [url, opts, classifier, guard] = calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string>; signal: AbortSignal },
      unknown,
      { guard: boolean },
    ];
    expect(url).toBe('https://receiver.example/hook');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"a":1}');
    expect(opts.headers).toEqual({ 'X-Test': '1' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(classifier).toBeInstanceOf(Function);
    expect(guard.guard).toBe(true); // SSRF guard defaults ON; the opt-out env flips it
  });

  it('resolves with the status on a 2xx answer', async () => {
    const { mock } = makeFetch(204);
    await expect(postWebhookPayload('https://r/hook', '{}', {}, 5000, mock as never)).resolves.toEqual({
      status: 204,
      statusText: 'OK',
    });
  });

  it('throws HTTP <status>: <statusText> on a non-2xx answer (the error shape both paths classify on)', async () => {
    const { mock } = makeFetch(502);
    mock.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway' });
    await expect(postWebhookPayload('https://r/hook', '{}', {}, 5000, mock as never)).rejects.toThrow(
      'HTTP 502: Bad Gateway',
    );
  });
});

describe('sanitizeCustomHeaders', () => {
  it('keeps ordinary custom headers and drops reserved system names', () => {
    expect(
      sanitizeCustomHeaders({
        'X-Custom': 'v',
        Authorization: 'Bearer t',
        'Content-Type': 'text/plain',
        'X-OpenWA-Event': 'x',
      }),
    ).toEqual({ 'X-Custom': 'v', Authorization: 'Bearer t' });
  });

  it('drops a custom User-Agent in any spelling', () => {
    expect(sanitizeCustomHeaders({ 'user-agent': 'x', 'USER-AGENT': 'y', 'User-Agent': 'z', 'X-Keep': 'v' })).toEqual({
      'X-Keep': 'v',
    });
  });

  it('keeps a custom header whose name only starts with User-Agent', () => {
    expect(sanitizeCustomHeaders({ 'User-Agent-Version': '2' })).toEqual({ 'User-Agent-Version': '2' });
  });

  // Asserted through undici's Headers, which is what goes on the wire: a case-variant key there is
  // joined with the system value rather than replaced by it.
  it('sends only the system User-Agent when the custom map carries a lowercase one', () => {
    const headers = buildDeliveryHeaders({ headers: { 'user-agent': 'custom' } }, 'message.received', 'k', 'd', '{}');
    expect(new Headers(headers).get('user-agent')).toBe('OpenWA-Webhook/1.0.0');
  });

  // undici throws on several of these (every delivery then fails with "fetch failed") and a wrong
  // Content-Length breaks the request framing; the HTTP client owns all of them.
  it('drops connection-level and framing headers the HTTP client owns', () => {
    expect(
      sanitizeCustomHeaders({
        Connection: 'close',
        'Content-Length': '1',
        Expect: '100-continue',
        'Keep-Alive': 'timeout=5',
        TE: 'trailers',
        Trailer: 'X-Sum',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'h2c',
        'X-Keep': 'v',
      }),
    ).toEqual({ 'X-Keep': 'v' });
  });
});

describe('isDeliverableWebhook', () => {
  const row = { active: true, events: ['message.received'] };

  it('accepts an active row subscribed to the event or to every event', () => {
    expect(isDeliverableWebhook(row, 'message.received')).toBe(true);
    expect(isDeliverableWebhook({ active: true, events: ['*'] }, 'message.ack')).toBe(true);
  });

  it('refuses a missing, disabled or unsubscribed row', () => {
    expect(isDeliverableWebhook(null, 'message.received')).toBe(false);
    expect(isDeliverableWebhook(undefined, 'message.received')).toBe(false);
    expect(isDeliverableWebhook({ ...row, active: false }, 'message.received')).toBe(false);
    expect(isDeliverableWebhook(row, 'message.ack')).toBe(false);
  });
});

describe('generateSignature', () => {
  it('matches the vector the SDK signature helpers are tested against', () => {
    const body =
      '{"event":"message.received","timestamp":"2026-02-02T10:00:00.000Z","sessionId":"s1","idempotencyKey":"k",' +
      '"deliveryId":"dlv_1","data":{"text":"h\u00e9llo \u{1F44B}"}}';
    expect(generateSignature(body, 'test-secret-0123456789')).toBe(
      'sha256=d74a41bb687f31ed4c932f76f524116100ca4120d2cabb7a469ee5d928122f70',
    );
  });
});
