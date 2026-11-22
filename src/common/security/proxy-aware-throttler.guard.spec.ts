import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { ProxyAwareThrottlerGuard } from './proxy-aware-throttler.guard';
import { DEFAULT_FORWARDED_HOP_MAX_SKEW_MS, FORWARDED_HOP_HEADER, signForwardedHop } from './inter-node-proxy-auth';

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
  ): Promise<{ headers: Record<string, string>; error: unknown }> => {
    const headers: Record<string, string> = {};
    const guard = Object.create(ProxyAwareThrottlerGuard.prototype) as ProxyAwareThrottlerGuard;
    // `options` is what the base constructor would set; getErrorMessage reads it.
    Object.assign(guard, {
      options: {},
      commonOptions: { setHeaders },
      errorMessage: 'ThrottlerException: Too Many Requests',
    });
    (guard as unknown as { getRequestResponse(c: unknown): unknown }).getRequestResponse = () => ({
      req: {},
      res: { header: (name: string, value: string) => void (headers[name] = value) },
    });
    let error: unknown;
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
    } catch (caught) {
      error = caught;
    }
    return { headers, error };
  };

  it('emits a plain Retry-After carrying the blocked window, and still throws', async () => {
    const { headers, error } = await invoke(undefined);
    expect(headers['Retry-After']).toBe('37');
    expect(error).toBeInstanceOf(ThrottlerException);
  });

  it('respects setHeaders: false, matching the flag the base guard gates its own header on', async () => {
    const { headers, error } = await invoke(false);
    expect(headers['Retry-After']).toBeUndefined();
    expect(error).toBeInstanceOf(ThrottlerException);
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

describe('ProxyAwareThrottlerGuard authenticated forwarded-hop skip', () => {
  const SECRET = 'shared-inter-node-secret-32chars!';
  const PATH = '/api/sessions/s1/messages/send-text?trace=1';
  const origEnvSecret = process.env.SESSION_PROXY_SECRET;
  const origTrustedProxies = process.env.TRUSTED_PROXIES;

  class MessagesController {}
  const sendText = function sendText(): void {};

  let storage: ThrottlerStorageService;

  beforeEach(() => {
    delete process.env.SESSION_PROXY_SECRET;
    delete process.env.TRUSTED_PROXIES;
    storage = new ThrottlerStorageService();
  });

  afterEach(() => {
    storage.onApplicationShutdown();
    if (origEnvSecret === undefined) delete process.env.SESSION_PROXY_SECRET;
    else process.env.SESSION_PROXY_SECRET = origEnvSecret;
    if (origTrustedProxies === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = origTrustedProxies;
  });

  const makeGuard = async (secret?: string): Promise<ProxyAwareThrottlerGuard> => {
    const configService =
      secret === undefined
        ? ({ get: jest.fn().mockReturnValue('') } as unknown as ConfigService)
        : ({
            get: jest.fn().mockImplementation((k: string) => (k === 'session.proxySecret' ? secret : undefined)),
          } as unknown as ConfigService);
    const guard = new ProxyAwareThrottlerGuard(
      { throttlers: [{ name: 'short', ttl: 60_000, limit: 1 }] },
      storage,
      new Reflector(),
      configService,
    );
    await guard.onModuleInit();
    return guard;
  };

  const contextFor = (req: Record<string, unknown>, responseHeaders: Record<string, string> = {}): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => sendText,
      getClass: () => MessagesController,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({
          header: (name: string, value: string | number) => {
            responseHeaders[name] = String(value);
          },
        }),
      }),
    }) as unknown as ExecutionContext;

  const baseReq = (headers: Record<string, string | string[] | undefined>, over: Record<string, unknown> = {}) => ({
    ip: '203.0.113.9',
    socket: { remoteAddress: '203.0.113.9' },
    method: 'POST',
    originalUrl: PATH,
    headers,
    ...over,
  });

  it('skips throttling for a validly signed forwarded hop without consuming tokens or emitting headers', async () => {
    const guard = await makeGuard(SECRET);
    const signed = signForwardedHop({ secret: SECRET, nodeId: 'node-a', method: 'POST', path: PATH });
    const resHeaders: Record<string, string> = {};

    await expect(guard.canActivate(contextFor(baseReq(signed), resHeaders))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(baseReq(signed), resHeaders))).resolves.toBe(true);
    expect(resHeaders).toEqual({});

    // Direct traffic still gets its full limit of 1 because the skipped hops consumed 0 tokens.
    await expect(guard.canActivate(contextFor(baseReq({})))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(baseReq({})))).rejects.toThrow(ThrottlerException);
  });

  it('falls back to req.url when req.originalUrl is absent', async () => {
    const guard = await makeGuard(SECRET);
    const signed = signForwardedHop({ secret: SECRET, nodeId: 'node-a', method: 'GET', path: '/api/sessions/s1' });
    const req = baseReq(signed, { method: 'GET', originalUrl: undefined, url: '/api/sessions/s1' });

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
  });

  it('throttles a spoofed x-openwa-forwarded header with no valid signature', async () => {
    const guard = await makeGuard(SECRET);
    const spoofed = baseReq({ [FORWARDED_HOP_HEADER]: 'node-a' });

    await expect(guard.canActivate(contextFor(spoofed))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(spoofed))).rejects.toThrow(ThrottlerException);
  });

  it('throttles when SESSION_PROXY_SECRET is unset even if hop signature headers are present', async () => {
    const guard = await makeGuard(undefined);
    const signed = signForwardedHop({ secret: SECRET, nodeId: 'node-a', method: 'POST', path: PATH });

    await expect(guard.canActivate(contextFor(baseReq(signed)))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(baseReq(signed)))).rejects.toThrow(ThrottlerException);
  });

  it.each([
    [
      'expired timestamp',
      () =>
        baseReq(
          signForwardedHop({
            secret: SECRET,
            nodeId: 'node-a',
            method: 'POST',
            path: PATH,
            nowMs: Date.now() - DEFAULT_FORWARDED_HOP_MAX_SKEW_MS - 5_000,
          }),
        ),
    ],
    [
      'future-skewed timestamp',
      () =>
        baseReq(
          signForwardedHop({
            secret: SECRET,
            nodeId: 'node-a',
            method: 'POST',
            path: PATH,
            nowMs: Date.now() + DEFAULT_FORWARDED_HOP_MAX_SKEW_MS + 5_000,
          }),
        ),
    ],
    [
      'tampered path',
      () =>
        baseReq(
          signForwardedHop({
            secret: SECRET,
            nodeId: 'node-a',
            method: 'POST',
            path: '/api/sessions/other/messages/send-text',
          }),
        ),
    ],
    [
      'tampered method',
      () =>
        baseReq(
          signForwardedHop({
            secret: SECRET,
            nodeId: 'node-a',
            method: 'GET',
            path: PATH,
          }),
        ),
    ],
    [
      'tampered nodeId',
      () => {
        const signed = signForwardedHop({ secret: SECRET, nodeId: 'node-a', method: 'POST', path: PATH });
        return baseReq({ ...signed, [FORWARDED_HOP_HEADER]: 'node-spoof' });
      },
    ],
    [
      'wrong secret',
      () =>
        baseReq(
          signForwardedHop({
            secret: 'another-secret-not-matching-node!',
            nodeId: 'node-a',
            method: 'POST',
            path: PATH,
          }),
        ),
    ],
  ])('throttles normally on %s (fail-closed)', async (_label, buildReq) => {
    const guard = await makeGuard(SECRET);
    await expect(guard.canActivate(contextFor(buildReq()))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(buildReq()))).rejects.toThrow(ThrottlerException);
  });
});
