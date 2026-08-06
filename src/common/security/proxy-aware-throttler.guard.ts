import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveClientIp, RequestLike } from '../utils/ip';

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
}
