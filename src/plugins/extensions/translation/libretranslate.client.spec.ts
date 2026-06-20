import { LibreTranslateClient } from './libretranslate.client';
import { SsrfBlockedError, withSafeFetch } from '../../../common/security/ssrf-guard';

// The client delegates the actual request to withSafeFetch (the IP-pinned, redirect-refusing primitive
// that the SSRF guard owns and ssrf-guard.spec.ts covers). Stub only that helper; keep SsrfBlockedError
// and isSsrfProtectionEnabled real so the client's circuit-exemption and guard-flag logic run for real.
jest.mock('../../../common/security/ssrf-guard', () => {
  const actual = jest.requireActual<typeof import('../../../common/security/ssrf-guard')>(
    '../../../common/security/ssrf-guard',
  );
  return { ...actual, withSafeFetch: jest.fn() };
});

const mockedWithSafeFetch = withSafeFetch as unknown as jest.Mock;

type CannedResponse = { ok: boolean; status?: number; json?: () => Promise<unknown> };
type WsfCall = [string, { method?: string; body?: string }, (r: unknown) => unknown, { guard: boolean }];

// Feed the client a canned response into its `use` callback, mirroring withSafeFetch's real contract
// (`return await use(response)`), so success/non-ok handling exercises the real client code.
const respondWith = (res: CannedResponse): void => {
  mockedWithSafeFetch.mockImplementation((_url: string, _init: unknown, use: (r: unknown) => unknown) =>
    Promise.resolve(use(res)),
  );
};

describe('LibreTranslateClient', () => {
  const ORIG_PROTECT = process.env.WEBHOOK_SSRF_PROTECT;
  beforeEach(() => mockedWithSafeFetch.mockReset());
  afterEach(() => {
    if (ORIG_PROTECT === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = ORIG_PROTECT;
  });

  it('routes the request through the IP-pinned withSafeFetch helper (guard on by default)', async () => {
    respondWith({ ok: true, json: () => Promise.resolve({ translatedText: 'Hola' }) });
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
    await client.translate('Hello', 'en', 'es');
    expect(mockedWithSafeFetch).toHaveBeenCalledTimes(1);
    const [url, , , opts] = mockedWithSafeFetch.mock.calls[0] as WsfCall;
    expect(url).toBe('http://lt:7001/translate');
    expect(opts).toEqual({ guard: true });
  });

  it('translate() sends q/source/target plus the api_key in the POST body and returns translatedText', async () => {
    respondWith({ ok: true, json: () => Promise.resolve({ translatedText: 'Hola' }) });
    const client = new LibreTranslateClient({ url: 'http://lt:7001', apiKey: 'secret', timeoutMs: 1000 });
    const out = await client.translate('Hello', 'en', 'es');
    expect(out).toBe('Hola');
    const [, init] = mockedWithSafeFetch.mock.calls[0] as WsfCall;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string) as Record<string, unknown>).toMatchObject({
      q: 'Hello',
      source: 'en',
      target: 'es',
      api_key: 'secret',
    });
  });

  it('detect() returns the top language', async () => {
    respondWith({ ok: true, json: () => Promise.resolve([{ language: 'fr', confidence: 0.97 }]) });
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
    expect(await client.detect('Bonjour')).toEqual({ lang: 'fr', confidence: 0.97 });
  });

  it('languages() uses GET with no body', async () => {
    respondWith({ ok: true, json: () => Promise.resolve([{ code: 'en' }, { code: 'es' }]) });
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
    expect(await client.languages()).toEqual(['en', 'es']);
    const [, init] = mockedWithSafeFetch.mock.calls[0] as WsfCall;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('passes guard:false to withSafeFetch when SSRF protection is disabled', async () => {
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    respondWith({ ok: true, json: () => Promise.resolve({ translatedText: 'x' }) });
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000 });
    await client.translate('a', 'en', 'es');
    const [, , , opts] = mockedWithSafeFetch.mock.calls[0] as WsfCall;
    expect(opts).toEqual({ guard: false });
  });

  it('propagates an SsrfBlockedError without tripping the circuit breaker', async () => {
    mockedWithSafeFetch.mockRejectedValue(new SsrfBlockedError('blocked internal address'));
    const client = new LibreTranslateClient({ url: 'http://lt:7001', timeoutMs: 1000, failureThreshold: 2 });
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(SsrfBlockedError);
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(SsrfBlockedError);
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(SsrfBlockedError);
    expect(client.isHealthy()).toBe(true);
  });

  it('a non-ok response rejects and counts toward the circuit breaker', async () => {
    respondWith({ ok: false, status: 500 });
    const client = new LibreTranslateClient({
      url: 'http://lt:7001',
      timeoutMs: 1000,
      failureThreshold: 2,
      cooldownMs: 60000,
    });
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(/HTTP 500/);
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(/HTTP 500/);
    expect(client.isHealthy()).toBe(false);
    await expect(client.translate('a', 'en', 'es')).rejects.toThrow(/circuit open/i);
  });
});
