import { Injectable } from '@nestjs/common';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

/**
 * Rate-limit bucket keyed on the ingress route's (pluginId, instanceId) instead of the client IP.
 *
 * Providers (Chatwoot, Meta, etc.) deliver every tenant's webhooks from the SAME egress IP, so the
 * global `ProxyAwareThrottlerGuard` — keyed on IP — lumps all instances into one bucket: a noisy
 * tenant on one instance would rate-limit every other instance sharing that provider's IP. Keying on
 * the instance instead sheds a single misbehaving `(pluginId, instanceId)` at the edge before it fills
 * the shared ingress queue, without punishing its neighbors.
 *
 * Applied alongside (not instead of) the global IP guard — see ingress.controller.ts. It deliberately
 * does NOT use `@Throttle()` to size its limit: `@Throttle` metadata is reflected on the route/handler
 * and is read by EVERY `ThrottlerGuard` instance that walks a tier of that name — including the global
 * per-IP guard, which shares the exact same `short`/`medium`/`long` tier list from the one process-wide
 * `ThrottlerModule.forRootAsync` config. Overriding one of those tiers here would silently retarget the
 * global guard's tolerance for this route too (proven by an earlier version of this guard's e2e test:
 * a second, unrelated instance got 429'd purely for sharing the test client's IP with a throttled one).
 * Instead, `onModuleInit` below replaces `this.throttlers` with a single self-contained tier that only
 * this guard instance evaluates, so its limit is fully independent of the global guard's tiers.
 */
@Injectable()
export class InstanceThrottlerGuard extends ProxyAwareThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [
      {
        name: 'instance',
        limit: Number(process.env.INGRESS_INSTANCE_LIMIT ?? 120),
        ttl: Number(process.env.INGRESS_INSTANCE_TTL ?? 60000),
      },
    ];
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const params = (req.params ?? {}) as { pluginId?: string; instanceId?: string };
    if (params.pluginId && params.instanceId) {
      return `ingress:${params.pluginId}:${params.instanceId}`;
    }
    // Defensive fallback: params should always be present on the ingress route, but if this guard
    // is ever reused elsewhere (or Nest fails to populate params), don't silently share one bucket.
    return super.getTracker(req);
  }
}
