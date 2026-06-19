// src/modules/translation/adapters/libretranslate.client.spec.ts
import { LibreTranslateClient } from './libretranslate.client';

describe('LibreTranslateClient', () => {
  const makeFetch = (impl: jest.Mock) => {
    global.fetch = impl;
  };

  const origAllow = process.env.SSRF_ALLOWED_HOSTS;
  beforeEach(() => {
    // The logic tests target host `lt`; allowlist it so the new SSRF guard lets them through.
    process.env.SSRF_ALLOWED_HOSTS = 'lt';
  });
  afterEach(() => {
    if (origAllow === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
    else process.env.SSRF_ALLOWED_HOSTS = origAllow;
    jest.restoreAllMocks();
  });

  describe('SSRF guard', () => {
    it('blocks a request to an internal address when SSRF protection is on (no fetch)', async () => {
      delete process.env.SSRF_ALLOWED_HOSTS; // 169.254.169.254 not allowlisted
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      const client = new LibreTranslateClient({ url: 'http://169.254.169.254:7001', timeoutMs: 1000 });
      await expect(client.translate('a', 'en', 'es')).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not trip the circuit breaker on a deterministic SSRF block', async () => {
      delete process.env.SSRF_ALLOWED_HOSTS;
      global.fetch = jest.fn();
      const client = new LibreTranslateClient({
        url: 'http://169.254.169.254:7001',
        timeoutMs: 1000,
        failureThreshold: 2,
      });
      await expect(client.translate('a', 'en', 'es')).rejects.toThrow();
      await expect(client.translate('a', 'en', 'es')).rejects.toThrow();
      await expect(client.translate('a', 'en', 'es')).rejects.toThrow();
      expect(client.isHealthy()).toBe(true);
    });

    it('refuses to follow redirects (redirect: error) on a guarded request', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ translatedText: 'x' }) });
      global.fetch = fetchMock;
      const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
      await client.translate('a', 'en', 'es');
      const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      expect(init.redirect).toBe('error');
    });
  });

  it('translate() posts q/source/target and returns translatedText', async () => {
    const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ translatedText: 'Hola' }),
    });
    makeFetch(fetchMock);
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
    const out = await client.translate('Hello', 'en', 'es');
    expect(out).toBe('Hola');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ q: 'Hello', source: 'en', target: 'es' });
  });

  it('detect() returns the top language', async () => {
    makeFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ language: 'fr', confidence: 0.97 }]),
      }),
    );
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
    expect(await client.detect('Bonjour')).toEqual({ lang: 'fr', confidence: 0.97 });
  });

  it('opens the circuit after N consecutive failures and reports unhealthy', async () => {
    makeFetch(jest.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('err') }));
    const client = new LibreTranslateClient({
      url: 'http://lt:7001',
      timeoutMs: 1000,
      failureThreshold: 2,
      cooldownMs: 60000,
    });
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow();
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow();
    expect(client.isHealthy()).toBe(false);
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(/circuit open/i);
  });
});
