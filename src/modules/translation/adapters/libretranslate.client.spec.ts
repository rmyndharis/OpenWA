// src/modules/translation/adapters/libretranslate.client.spec.ts
import { LibreTranslateClient } from './libretranslate.client';

describe('LibreTranslateClient', () => {
  const makeFetch = (impl: jest.Mock) => {
    global.fetch = impl;
  };

  afterEach(() => jest.restoreAllMocks());

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
