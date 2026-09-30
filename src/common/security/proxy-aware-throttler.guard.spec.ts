import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';

/**
 * Regression lock: the throttler must bucket on the resolved client IP, not the
 * proxy IP — so one abusive client cannot rate-limit everyone behind a reverse proxy.
 */
const reqFrom = (socketIp: string, xff?: string): unknown => ({
  ip: socketIp,
  socket: { remoteAddress: socketIp },
  headers: xff !== undefined ? { 'x-forwarded-for': xff } : {},
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

  // getTracker uses process.env, resolveClientIp, and this.ipv6SubnetPrefix (which defaults to
  // 64 when undefined), so we can invoke it on a prototype instance without the throttler's
  // storage/reflector deps.
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

  it('masks directly connected IPv6 clients to a /64 so addresses in the same subnet share a tracker', async () => {
    delete process.env.TRUSTED_PROXIES;
    const a = await track(reqFrom('2001:db8:0:1::1'));
    const b = await track(reqFrom('2001:db8:0:1:dead:beef:1:2'));
    expect(a).toBe('2001:db8:0:1::/64');
    expect(b).toBe('2001:db8:0:1::/64');
    expect(a).toBe(b);
  });

  it('gives directly connected IPv6 clients in different /64 subnets independent buckets', async () => {
    delete process.env.TRUSTED_PROXIES;
    const a = await track(reqFrom('2001:db8:0:1::1'));
    const b = await track(reqFrom('2001:db8:0:2::1'));
    expect(a).toBe('2001:db8:0:1::/64');
    expect(b).toBe('2001:db8:0:2::/64');
    expect(a).not.toBe(b);
  });

  it('masks forwarded IPv6 clients behind a trusted proxy to a /64', async () => {
    process.env.TRUSTED_PROXIES = '172.18.0.0/16';
    const a = await track(reqFrom('172.18.0.5', '2001:db8:0:1::1'));
    const b = await track(reqFrom('172.18.0.5', '2001:db8:0:1::2'));
    const c = await track(reqFrom('172.18.0.5', '2001:db8:0:2::1'));
    expect(a).toBe('2001:db8:0:1::/64');
    expect(b).toBe('2001:db8:0:1::/64');
    expect(a).toBe(b);
    expect(c).toBe('2001:db8:0:2::/64');
    expect(a).not.toBe(c);
  });

  it('leaves IPv4, IPv4-mapped, and loopback addresses unchanged', async () => {
    delete process.env.TRUSTED_PROXIES;
    expect(await track(reqFrom('203.0.113.9'))).toBe('203.0.113.9');
    expect(await track(reqFrom('::ffff:203.0.113.9'))).toBe('203.0.113.9');
    expect(await track(reqFrom('::1'))).toBe('::1');
  });

  it('honors a custom ipv6SubnetPrefix configured on the guard', async () => {
    delete process.env.TRUSTED_PROXIES;
    const customGuard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;
    Object.assign(customGuard, { ipv6SubnetPrefix: 48 });
    const trackCustom = (req: unknown): Promise<string> =>
      (customGuard as unknown as { getTracker(r: unknown): Promise<string> }).getTracker(req);
    expect(await trackCustom(reqFrom('2001:db8:0:1::1'))).toBe('2001:db8::/48');
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

/**
 * The library writes only `Retry-After-<tier>`, a spelling no HTTP client reads, so a shed request
 * advertised a retry hint nothing could act on. The plain header must go out with the same value.
 */
describe('ProxyAwareThrottlerGuard.throwThrottlingException', () => {
  const invoke = async (
    setHeaders: boolean | undefined,
  ): Promise<{ headers: Record<string, string>; threw: boolean }> => {
    const headers: Record<string, string> = {};
    const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;
    Object.assign(guard, { commonOptions: { setHeaders }, errorMessage: 'ThrottlerException: Too Many Requests' });
    (guard as unknown as { getRequestResponse(c: unknown): unknown }).getRequestResponse = () => ({
      req: {},
      res: { header: (name: string, value: string) => void (headers[name] = value) },
    });
    let threw = false;
    try {
      await (
        guard as unknown as {
          throwThrottlingException(c: unknown, d: unknown): Promise<void>;
        }
      ).throwThrottlingException(
        {},
        {
          limit: 10,
          ttl: 60,
          key: 'k',
          tracker: '1.2.3.4',
          totalHits: 11,
          timeToExpire: 42,
          isBlocked: true,
          timeToBlockExpire: 37,
        },
      );
    } catch {
      threw = true;
    }
    return { headers, threw };
  };

  it('emits a plain Retry-After carrying the blocked window, and still throws', async () => {
    const { headers, threw } = await invoke(undefined);
    expect(headers['Retry-After']).toBe('37');
    expect(threw).toBe(true);
  });

  it('respects setHeaders: false, matching the flag the base guard gates its own header on', async () => {
    const { headers, threw } = await invoke(false);
    expect(headers['Retry-After']).toBeUndefined();
    expect(threw).toBe(true);
  });
});

/**
 * Pins the bucket scope the docs describe: every window is counted per route handler per client IP
 * (the library's generateKey includes the controller and handler names). docs/04 section 4.6,
 * docs/10 and docs/12 say so; a generateKey override that changes the scope must update them too.
 */
describe('ProxyAwareThrottlerGuard bucket scope', () => {
  class SessionsController {}
  const list = function list(): void {};
  const get = function get(): void {};
  let storage: ThrottlerStorageService;

  afterEach(() => storage.onApplicationShutdown());

  it('counts each route handler separately for one client IP', async () => {
    storage = new ThrottlerStorageService();
    const guard = new ProxyAwareThrottlerGuard(
      { throttlers: [{ name: 'short', ttl: 1000, limit: 10 }] },
      storage,
      new Reflector(),
    );
    await guard.onModuleInit();
    delete process.env.TRUSTED_PROXIES;
    const req = { ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' }, headers: {} };
    const contextFor = (handler: () => void): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => SessionsController,
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
      }) as unknown as ExecutionContext;
    for (let i = 0; i < 10; i++) {
      await expect(guard.canActivate(contextFor(list))).resolves.toBe(true);
      await expect(guard.canActivate(contextFor(get))).resolves.toBe(true);
    }
    await expect(guard.canActivate(contextFor(list))).rejects.toThrow(ThrottlerException);
    await expect(guard.canActivate(contextFor(get))).rejects.toThrow(ThrottlerException);
  });
});
