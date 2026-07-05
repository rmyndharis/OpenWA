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
});
