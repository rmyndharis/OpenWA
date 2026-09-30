import type { ThrottlerStorage } from '@nestjs/throttler';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

export interface IngressAdmission {
  ok: boolean;
  headers: Record<string, string>;
}

/**
 * The per-instance ingress rate bucket, charged by IngressService only once a delivery has passed
 * signature verification. Providers deliver every tenant's webhooks from one egress IP, so this is
 * what keeps a noisy (pluginId, instanceId) from starving its neighbours. Traffic that fails earlier
 * is bounded by the per-client-IP tier in InstanceThrottlerGuard alone.
 *
 * Header names and values match what the throttler guard emitted for this tier. Every value is a
 * string, because safeAckHeaders drops anything else on the way to the wire.
 */
export async function admitIngressInstance(
  storage: ThrottlerStorage,
  pluginId: string,
  instanceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngressAdmission> {
  // Blank-as-unset, like the guard's tiers: a blank compose forward must not become a limit of 0.
  const limit = resolveNonNegativeIntEnv(env.INGRESS_INSTANCE_LIMIT, 120);
  const ttl = resolveNonNegativeIntEnv(env.INGRESS_INSTANCE_TTL, 60000);
  // The block lasts one window, as the guard's `blockDuration || ttl` did; 0 would never block.
  const record = await storage.increment(`ingress-instance:${pluginId}:${instanceId}`, ttl, limit, ttl, 'instance');
  if (record.isBlocked) {
    const wait = String(record.timeToBlockExpire);
    return { ok: false, headers: { 'Retry-After-instance': wait, 'Retry-After': wait } };
  }
  return {
    ok: true,
    headers: {
      'X-RateLimit-Limit-instance': String(limit),
      'X-RateLimit-Remaining-instance': String(Math.max(0, limit - record.totalHits)),
      'X-RateLimit-Reset-instance': String(record.timeToExpire),
    },
  };
}
