import { describe, expect, it } from 'vitest';
import { OpenWAClient, OpenWAApiError, OpenWANotFoundError } from '../src';
import { MockTransport } from './helpers';

function client(transport: MockTransport): OpenWAClient {
  return new OpenWAClient({
    baseUrl: 'http://localhost:2785',
    apiKey: 'owa_k1_test',
    fetch: transport.asFetch(),
  });
}

describe('OpenWAClient', () => {
  it('requires baseUrl and apiKey', () => {
    expect(() => new OpenWAClient({ baseUrl: '', apiKey: 'x' })).toThrow();
    expect(() => new OpenWAClient({ baseUrl: 'http://x', apiKey: '' })).toThrow();
  });

  it('sends the API key as X-API-Key and JSON content type', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', { body: [] });
    await client(t).sessions.list();
    expect(t.lastCall!.headers['x-api-key']).toBe('owa_k1_test');
    expect(t.lastCall!.headers['content-type']).toBe('application/json');
  });

  it('strips a trailing slash from baseUrl', async () => {
    const t = new MockTransport().on('GET', '/api/sessions', { body: [] });
    const c = new OpenWAClient({ baseUrl: 'http://localhost:2785/', apiKey: 'k', fetch: t.asFetch() });
    await c.sessions.list();
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions');
  });

  it('serializes query params and skips null/undefined', async () => {
    const t = new MockTransport().on('GET', /\/messages/, { body: [] });
    await client(t).messages.list('s1', { chatId: 'a@c.us', from: undefined, limit: 10 });
    expect(t.lastCall!.url).toContain('chatId=a%40c.us');
    expect(t.lastCall!.url).toContain('limit=10');
    expect(t.lastCall!.url).not.toContain('from=');
  });

  it('maps a 404 to OpenWANotFoundError with parsed body', async () => {
    const t = new MockTransport().on('GET', '/api/sessions/missing', {
      status: 404,
      body: { statusCode: 404, message: 'Session not found', error: 'Not Found' },
    });
    await expect(client(t).sessions.get('missing')).rejects.toBeInstanceOf(OpenWANotFoundError);
    await expect(client(t).sessions.get('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('exposes all expected resource properties', () => {
    const c = client(new MockTransport());
    for (const r of ['sessions', 'messages', 'contacts', 'groups', 'webhooks', 'chats', 'status', 'health']) {
      expect(c).toHaveProperty(r);
    }
  });

  it('treats 204 as a null result', async () => {
    const t = new MockTransport().on('DELETE', '/api/sessions/x', { status: 204 });
    await expect(client(t).sessions.delete('x')).resolves.toBeNull();
  });

  it('OpenWAApiError.fromResponse parses the NestJS envelope', async () => {
    const t = new MockTransport().on('POST', /send-text/, {
      status: 409,
      body: { statusCode: 409, message: 'Engine not ready', error: 'Conflict' },
    });
    await expect(client(t).messages.sendText('s', { chatId: 'a@c.us', text: 'hi' })).rejects.toBeInstanceOf(
      OpenWAApiError,
    );
  });
});
