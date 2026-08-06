import { InstanceThrottlerGuard } from './instance-throttler.guard';

describe('InstanceThrottlerGuard', () => {
  it('keys the bucket on (pluginId, instanceId) from the route params, not the client IP', async () => {
    const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    const req = { params: { pluginId: 'chatwoot', instanceId: 'acct1' }, ip: '203.0.113.9' };
    await expect(guard.getTracker(req)).resolves.toBe('ingress:chatwoot:acct1');
  });

  it('falls back to the client IP when params are missing (defensive)', async () => {
    const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    await expect(guard.getTracker({ params: {}, ip: '203.0.113.9' })).resolves.toContain('203.0.113.9');
  });

  it('falls back to the client IP when only one of pluginId/instanceId is present', async () => {
    const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
      getTracker(req: unknown): Promise<string>;
    };
    const req = { params: { pluginId: 'chatwoot' }, ip: '203.0.113.9' };
    await expect(guard.getTracker(req)).resolves.toContain('203.0.113.9');
  });

  // A blank compose `${KEY:-}` forward must never become a limit of 0: the throttler would then
  // reject the first hit on every instance, silently 429ing all inbound webhooks.
  describe('tier resolution from the environment', () => {
    const KEYS = ['INGRESS_INSTANCE_LIMIT', 'INGRESS_INSTANCE_TTL'] as const;
    const saved: Array<[string, string | undefined]> = [];
    beforeEach(() => {
      saved.length = 0;
      for (const k of KEYS) saved.push([k, process.env[k]]);
    });
    afterEach(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const resolveTiers = async (): Promise<Array<{ limit: number; ttl: number }>> => {
      const guard = Object.create(InstanceThrottlerGuard.prototype) as InstanceThrottlerGuard & {
        throttlers: Array<{ limit: number; ttl: number }>;
        onModuleInit(): Promise<void>;
      };
      // Skip ThrottlerGuard's own onModuleInit (needs the injected storage/options).
      jest.spyOn(Object.getPrototypeOf(InstanceThrottlerGuard.prototype), 'onModuleInit').mockResolvedValue(undefined);
      await guard.onModuleInit();
      return guard.throttlers;
    };

    it.each(['', '   '])('treats a blank value (%p) as unset instead of a limit of 0', async blank => {
      process.env.INGRESS_INSTANCE_LIMIT = blank;
      process.env.INGRESS_INSTANCE_TTL = blank;
      expect(await resolveTiers()).toEqual([{ name: 'instance', limit: 120, ttl: 60000 }]);
    });

    it('honors real values', async () => {
      process.env.INGRESS_INSTANCE_LIMIT = '5';
      process.env.INGRESS_INSTANCE_TTL = '1000';
      expect(await resolveTiers()).toEqual([{ name: 'instance', limit: 5, ttl: 1000 }]);
    });
  });
});
