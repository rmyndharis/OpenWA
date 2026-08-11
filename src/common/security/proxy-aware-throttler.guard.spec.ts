import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';

/**
 * Regression lock: the throttler must bucket on the resolved client IP, not the
 * proxy IP — so one abusive client cannot rate-limit everyone behind a reverse proxy.
 */
describe('ProxyAwareThrottlerGuard.getTracker', () => {
  const orig = process.env.TRUSTED_PROXIES;

  // getTracker uses only process.env + the pure resolveClientIp (no `this`), so we can
  // invoke it on a prototype instance without the throttler's storage/reflector deps.
  const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;
  const track = (req: unknown): Promise<string> =>
    (guard as unknown as { getTracker(r: unknown): Promise<string> }).getTracker(req);

  const reqFrom = (socketIp: string, xff?: string): unknown => ({
    ip: socketIp,
    socket: { remoteAddress: socketIp },
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });

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
