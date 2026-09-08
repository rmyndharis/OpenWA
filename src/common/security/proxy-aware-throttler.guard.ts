import { createHash } from 'node:crypto';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientIp, RequestLike } from '../utils/ip';
import { createLogger } from '../services/logger.service';

const logger = createLogger('ProxyAwareThrottlerGuard');

/**
 * The single metadata key a bare `@SkipThrottle()` writes.
 *
 * The decorator defaults its argument to `{ default: true }` and writes `THROTTLER:SKIP` + each key
 * of that object, so the bare form produces exactly this one. The base guard instead reads
 * `THROTTLER:SKIP` + the name of each CONFIGURED tier, and this application names its tiers `short`,
 * `medium` and `long` — so the two spellings never intersect and a bare decorator is inert.
 */
const LIBRARY_DEFAULT_SKIP_KEY = 'THROTTLER:SKIPdefault';

/**
 * Rate-limit bucket keyed on the client's identity.
 *
 * The stock ThrottlerGuard keys on `req.ip`, which — behind the documented reverse
 * proxy with Express `trust proxy` disabled — resolves to the proxy for every client,
 * so all traffic shares ONE bucket and a single abuser rate-limits everyone (self-DoS).
 *
 * This guard keys on a per-caller identity instead:
 *  - When the request presents an API key (`x-api-key` or `Authorization: Bearer`, the two
 *    spellings ApiKeyGuard accepts), the bucket is keyed on a SHA-256 hash of that key. This is
 *    the per-key bound that server-to-server gateways need: a SaaS control-plane (or any proxy)
 *    forwards many tenants from ONE egress IP, and an IP-keyed bucket would lump every tenant
 *    into a single budget — a busy tenant's polling rate-limits all its neighbours. Keying on the
 *    API key gives each tenant an independent bucket, and the hash keeps the raw key out of Redis
 *    key names and logs.
 *  - Otherwise the bucket stays keyed on the same trusted-proxy-aware client-IP resolution as
 *    ApiKeyGuard: with no TRUSTED_PROXIES configured it falls back to the socket IP (no behavior
 *    change and no XFF-spoofing risk); with trusted proxies it keys on the real forwarded client
 *    IP. Anonymous traffic still has a flood bound per origin.
 */
@Injectable()
export class ProxyAwareThrottlerGuard extends ThrottlerGuard {
  /**
   * The shared-bucket condition is deployment-wide, so the warning fires once per guard instance.
   * In practice that is once per process: this guard runs as the singleton APP_GUARD. The only other
   * instance is InstanceThrottlerGuard, whose defensive super.getTracker fallback (missing route
   * params) is unreachable on the real ingress route, so at most one extra line could ever appear.
   *
   * The warning only applies to the IP-keyed (anonymous) path: on every API-key route the keyed
   * bucket is keyed per-tenant, not on the proxy address, so a per-IP collapse cannot occur there.
   */
  private warnedSharedProxyBucket = false;

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const trustedProxies = (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map(proxy => proxy.trim())
      .filter(Boolean);
    const apiKey = this.extractApiKey(req);
    if (apiKey) {
      // Per-tenant bucket. Hash so the raw key never appears in the throttler's Redis key names.
      return Promise.resolve(createHash('sha256').update(`apikey:${apiKey}`).digest('hex'));
    }
    // An X-Forwarded-For header with an empty TRUSTED_PROXIES is the silent self-DoS this guard
    // exists to prevent: every client collapses onto the proxy's socket address, so all traffic
    // shares ONE bucket per tier and one abuser rate-limits everyone. The header itself must stay
    // untrusted (spoofable), so the fix is operator-side: name the proxy in TRUSTED_PROXIES. Warn
    // once instead of per request; the stock-resolve fallback below is still the safe default.
    if (trustedProxies.length === 0 && !this.warnedSharedProxyBucket) {
      const headers = (req.headers ?? {}) as Record<string, unknown>;
      if (headers['x-forwarded-for'] !== undefined) {
        this.warnedSharedProxyBucket = true;
        logger.warn(
          'X-Forwarded-For is present but TRUSTED_PROXIES is empty: every client shares one ' +
            'rate-limit bucket keyed on the proxy address (and per-key IP allowlists see the proxy ' +
            'too). Set TRUSTED_PROXIES to the proxy address/subnet to key limits per client.',
        );
      }
    }
    return Promise.resolve(resolveClientIp(req as unknown as RequestLike, trustedProxies));
  }

  /**
   * The two API-key spellings ApiKeyGuard accepts (see its extractApiKey): an `x-api-key` header
   * or an `Authorization: Bearer` value. Mirrored here so the bucket tracks the same identity the
   * auth layer will validate — a request carrying either header is bucketed per key, not per IP.
   */
  private extractApiKey(req: Record<string, unknown>): string | undefined {
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    const xApiKey = headers['x-api-key'];
    if (xApiKey !== undefined) {
      return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
    }
    const authHeader = headers['authorization'];
    const bearer = authHeader !== undefined ? (Array.isArray(authHeader) ? authHeader[0] : authHeader) : undefined;
    if (bearer?.startsWith('Bearer ')) return bearer.substring(7);
    return undefined;
  }

  /**
   * Honour a bare `@SkipThrottle()` as "skip every tier this guard evaluates".
   *
   * `canActivate` calls this before the tier loop, so a route exempted here costs no storage
   * round-trip for any tier and emits no rate-limit headers — which is what a scrape or a liveness
   * probe should cost. Reading the library's own default key here also covers every future bare
   * `@SkipThrottle()` rather than requiring each call site to re-list the configured tier names.
   *
   * An explicit `@SkipThrottle({ default: false })` writes `false` and is not an exemption, so the
   * strict comparison matters: only `true` skips.
   */
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(LIBRARY_DEFAULT_SKIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return Promise.resolve(skip === true);
  }
}
