import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientIp, RequestLike } from '../utils/ip';

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
 * Rate-limit bucket keyed on the resolved client IP.
 *
 * The stock ThrottlerGuard keys on `req.ip`, which — behind the documented reverse
 * proxy with Express `trust proxy` disabled — resolves to the proxy for every client,
 * so all traffic shares ONE bucket and a single abuser rate-limits everyone (self-DoS).
 *
 * This reuses the same trusted-proxy-aware resolution as ApiKeyGuard: with no
 * TRUSTED_PROXIES configured it falls back to the socket IP (no behavior change and no
 * XFF-spoofing risk); with trusted proxies it keys on the real forwarded client IP.
 */
@Injectable()
export class ProxyAwareThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const trustedProxies = (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map(proxy => proxy.trim())
      .filter(Boolean);
    return Promise.resolve(resolveClientIp(req as unknown as RequestLike, trustedProxies));
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
