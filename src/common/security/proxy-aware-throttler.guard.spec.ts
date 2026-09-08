import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';

/**
 * Regression lock: the throttler must bucket on the resolved client IP, not the
 * proxy IP — so one abusive client cannot rate-limit everyone behind a reverse proxy.
 */
const reqFrom = (socketIp: string, xff?: string, extras?: Record<string, unknown>): unknown => ({
  ip: socketIp,
  socket: { remoteAddress: socketIp },
  headers: xff !== undefined ? { 'x-forwarded-for': xff, ...extras } : { ...extras },
});

describe('ProxyAwareThrottlerGuard.getTracker', () => {
  const orig = process.env.TRUSTED_PROXIES;
  // The shared instance below trips the shared-bucket warning once (first test sends an XFF);
  // silence it so the suite output stays clean; the warning itself has its own describe below.
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  // getTracker uses only process.env + the pure resolveClientIp (no `this`), so we can
  // invoke it on a prototype instance without the throttler's storage/reflector deps.
  const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;
  const track = (req: unknown): Promise<string> =>
    (guard as unknown as { getTracker(r: unknown): Promise<string> }).getTracker(req);

  afterEach(() => {
    if (orig === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = orig;
  });

  it('with no trusted proxies, keys on the socket IP and ignores a spoofed XFF', async () => {
    delete process.env.TRUSTED_PROXIES;
    expect(await track(reqFrom('203.0.113.9', '1.1.1.1'))).toBe('203.0.113.9');
  });

  it('with a trusted proxy peer, keys on the real forwarded client IP', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    expect(await track(reqFrom('172.18.0.5', '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('gives two distinct forwarded clients independent buckets', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    const a = await track(reqFrom('172.18.0.5', '203.0.113.9'));
    const b = await track(reqFrom('172.18.0.5', '198.51.100.7'));
    expect(a).not.toBe(b);
  });

  it('ignores XFF from an untrusted peer (anti-spoof)', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    // peer 203.0.113.9 is NOT a trusted proxy → its XFF is ignored, key on the socket IP
    expect(await track(reqFrom('203.0.113.9', '10.0.0.1'))).toBe('203.0.113.9');
  });

  it('keys on a hash of the x-api-key when one is presented', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    const expected = createHash('sha256').update('apikey:owsk_tenant-a').digest('hex');
    expect(await track(reqFrom('172.18.0.5', undefined, { 'x-api-key': 'owsk_tenant-a' }))).toBe(expected);
  });

  it('keys on a hash of the Bearer token when presented via Authorization', async () => {
    delete process.env.TRUSTED_PROXIES;
    const expected = createHash('sha256').update('apikey:owsk_tenant-b').digest('hex');
    expect(await track(reqFrom('203.0.113.9', undefined, { authorization: 'Bearer owsk_tenant-b' }))).toBe(expected);
  });

  it('gives tenants behind the same proxy IP independent per-key buckets', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    // Two tenants share one forwarded client IP (the SaaS control-plane): each must get its own
    // bucket so a busy tenant cannot rate-limit its neighbours (the self-DoS this guard prevents).
    const a = await track(reqFrom('172.18.0.5', '203.0.113.9', { 'x-api-key': 'owsk_tenant-a' }));
    const b = await track(reqFrom('172.18.0.5', '203.0.113.9', { 'x-api-key': 'owsk_tenant-b' }));
    expect(a).not.toBe(b);
    expect(a).toBe(createHash('sha256').update('apikey:owsk_tenant-a').digest('hex'));
  });

  it('still buckets a request carrying no API key on the client IP', async () => {
    delete process.env.TRUSTED_PROXIES;
    expect(await track(reqFrom('203.0.113.9'))).toBe('203.0.113.9');
  });
});

/**
 * An X-Forwarded-For header with an empty TRUSTED_PROXIES is the deployment-wide shared-bucket
 * condition (every client keys on the proxy address); it must surface as a one-time warning rather
 * than stay silent. The header stays untrusted either way; the fix is operator-side.
 */
describe('ProxyAwareThrottlerGuard shared-bucket warning', () => {
  const orig = process.env.TRUSTED_PROXIES;
  let warn: jest.SpyInstance;

  const trackOn = (guard: unknown, req: unknown): Promise<string> =>
    (guard as { getTracker(r: unknown): Promise<string> }).getTracker(req);

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    if (orig === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = orig;
  });

  it('warns exactly once when a proxied request arrives with no trusted proxies', async () => {
    delete process.env.TRUSTED_PROXIES;
    const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;

    expect(await trackOn(guard, reqFrom('172.18.0.5', '203.0.113.9'))).toBe('172.18.0.5');
    expect(await trackOn(guard, reqFrom('172.18.0.5', '198.51.100.7'))).toBe('172.18.0.5');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('TRUSTED_PROXIES is empty');
  });

  it('stays silent when the proxy is trusted', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;

    expect(await trackOn(guard, reqFrom('172.18.0.5', '203.0.113.9'))).toBe('203.0.113.9');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns for an empty-string XFF header too (a stripped header still means a proxy hop)', async () => {
    delete process.env.TRUSTED_PROXIES;
    const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;

    expect(await trackOn(guard, reqFrom('172.18.0.5', ''))).toBe('172.18.0.5');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent for direct traffic with no XFF header', async () => {
    delete process.env.TRUSTED_PROXIES;
    const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;

    expect(await trackOn(guard, reqFrom('203.0.113.9'))).toBe('203.0.113.9');
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Regression lock: a bare `@SkipThrottle()` must actually exempt the route.
 *
 * The decorator writes ONE metadata key, `THROTTLER:SKIP` + the key of its argument object, which
 * defaults to `{ default: true }`. The base guard reads `THROTTLER:SKIP` + the name of each
 * CONFIGURED tier, and this application names its tiers `short`, `medium` and `long`. The two
 * spellings never intersect, so a bare decorator writes a key nothing reads and the route stays
 * throttled. Unlike the tier loop, `shouldSkip` runs before any tier is evaluated, so honouring the
 * library's default key here exempts the route from every tier and from the storage round-trip each
 * one would perform.
 *
 * These cases instantiate the guard properly rather than via `Object.create`: unlike `getTracker`,
 * `shouldSkip` reads `this.reflector`.
 */
describe('ProxyAwareThrottlerGuard.shouldSkip', () => {
  const LIBRARY_DEFAULT_SKIP_KEY = 'THROTTLER:SKIPdefault';

  const handler = (): void => undefined;
  class Controller {}
  const context = {
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;

  function guardReading(metadata: boolean | undefined): {
    skip: () => Promise<boolean>;
    reflector: { getAllAndOverride: jest.Mock };
  } {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(metadata) };
    type GuardArgs = ConstructorParameters<typeof ProxyAwareThrottlerGuard>;
    const guard = new ProxyAwareThrottlerGuard(
      { throttlers: [] },
      {} as GuardArgs[1],
      reflector as unknown as Reflector,
    );
    const skip = (): Promise<boolean> =>
      (guard as unknown as { shouldSkip(c: ExecutionContext): Promise<boolean> }).shouldSkip(context);
    return { skip, reflector };
  }

  it('exempts a route whose bare @SkipThrottle() wrote the library default key', async () => {
    const { skip } = guardReading(true);
    expect(await skip()).toBe(true);
  });

  it('reads the key the library actually writes, on handler then class', async () => {
    const { skip, reflector } = guardReading(true);
    await skip();
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(LIBRARY_DEFAULT_SKIP_KEY, [handler, Controller]);
  });

  it('does not exempt a route carrying no skip metadata', async () => {
    const { skip } = guardReading(undefined);
    expect(await skip()).toBe(false);
  });

  it('does not exempt an explicit opt-out — @SkipThrottle({ default: false })', async () => {
    const { skip } = guardReading(false);
    expect(await skip()).toBe(false);
  });
});
