import { ThrottlerStorageService } from '@nestjs/throttler';
import { admitIngressInstance } from './ingress-instance-limit';

describe('admitIngressInstance', () => {
  let storage: ThrottlerStorageService;
  const env = { INGRESS_INSTANCE_LIMIT: '2', INGRESS_INSTANCE_TTL: '60000' };

  beforeEach(() => {
    storage = new ThrottlerStorageService();
  });
  afterEach(() => storage.onApplicationShutdown());

  it('admits up to the limit with rate headers, then sheds with Retry-After', async () => {
    const first = await admitIngressInstance(storage, 'chatwoot', 'acct1', env);
    expect(first).toEqual({
      ok: true,
      headers: {
        'X-RateLimit-Limit-instance': '2',
        'X-RateLimit-Remaining-instance': '1',
        'X-RateLimit-Reset-instance': expect.any(String) as string,
      },
    });
    const second = await admitIngressInstance(storage, 'chatwoot', 'acct1', env);
    expect(second.ok).toBe(true);
    expect(second.headers['X-RateLimit-Remaining-instance']).toBe('0');

    // The block must hold with the in-memory storage too: a block duration of 0 there never blocks.
    const third = await admitIngressInstance(storage, 'chatwoot', 'acct1', env);
    expect(third.ok).toBe(false);
    expect(Number(third.headers['Retry-After'])).toBeGreaterThan(0);
    expect(third.headers['Retry-After-instance']).toBe(third.headers['Retry-After']);
  });

  it('keeps an independent bucket per instance', async () => {
    for (let i = 0; i < 3; i++) await admitIngressInstance(storage, 'chatwoot', 'acct1', env);
    await expect(admitIngressInstance(storage, 'chatwoot', 'acct2', env)).resolves.toMatchObject({ ok: true });
  });

  it('falls back to 120 per 60 s when the variables are blank', async () => {
    const result = await admitIngressInstance(storage, 'chatwoot', 'acct1', {
      INGRESS_INSTANCE_LIMIT: ' ',
      INGRESS_INSTANCE_TTL: '',
    });
    expect(result.headers['X-RateLimit-Limit-instance']).toBe('120');
    expect(Number(result.headers['X-RateLimit-Reset-instance'])).toBeLessThanOrEqual(60);
  });
});
