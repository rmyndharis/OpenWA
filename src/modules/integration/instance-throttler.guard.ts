import { Injectable } from '@nestjs/common';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

/**
 * The ingress route's pre-authentication rate bound, keyed on the client IP.
 *
 * The route is `@Public`, so this is the only bound on traffic that has not proven anything yet:
 * unknown instances, failed challenges, oversized bodies and bad signatures. The per-instance bound
 * that keeps one noisy tenant from starving the others on a provider's shared egress IP is charged
 * by IngressService only once a delivery's signature verifies (see admitIngressInstance).
 *
 * It deliberately does NOT use `@Throttle()` to size its limit: `@Throttle` metadata is reflected on
 * the route/handler and is read by EVERY `ThrottlerGuard` instance that walks a tier of that name,
 * including the global per-IP guard, which shares the `short`/`medium`/`long` tier list from the one
 * process-wide `ThrottlerModule.forRootAsync` config. Overriding one of those tiers here would silently
 * retarget the global guard's tolerance for this route too. Instead, `onModuleInit` below replaces
 * `this.throttlers` with its own tier that only this guard instance evaluates.
 */
@Injectable()
export class InstanceThrottlerGuard extends ProxyAwareThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    // Blank-as-unset: a blank compose `${KEY:-}` forward must not become a limit of 0, which rejects
    // the very first hit. An explicit 0 is still rejected at boot by env.validation.
    this.throttlers = [
      {
        // Sized well ABOVE the per-instance limit so it never becomes the binding constraint for a
        // legitimate provider fanning many tenants through one egress IP: 10x the instance default.
        // Raise it with `INGRESS_IP_LIMIT` when one IP legitimately drives more than that. The tier
        // keeps the inherited proxy-aware client-IP tracker.
        name: 'ingress-ip',
        limit: resolveNonNegativeIntEnv(process.env.INGRESS_IP_LIMIT, 1200),
        ttl: resolveNonNegativeIntEnv(process.env.INGRESS_INSTANCE_TTL, 60000),
      },
    ];
  }

  /**
   * This guard does NOT honour a bare `@SkipThrottle()`. The ingress controller carries one so the
   * GLOBAL per-IP guard skips the route: its medium tier (default 100/min) sits BELOW the
   * per-instance default (120/min), so a provider delivering every tenant's webhooks from one shared
   * egress IP was 429'd at the IP tier before the instance bound ever fired. This guard carries the
   * route's own limit instead, and its tier stays unconditional: skipping it would leave a `@Public`
   * route with no rate bound at all.
   */
  protected shouldSkip(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
