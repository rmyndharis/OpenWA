import { ConflictException } from '@nestjs/common';
import { DECORATORS } from '@nestjs/swagger';
import { IntegrationInstanceController } from './integration-instance.controller';
import type { PluginInstanceService } from './plugin-instance.service';
import type { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import type { AuditService } from '../audit/audit.service';
import type { ScopeBindingService } from './scope-binding.service';

// A config PATCH of an instance whose plugin is not loaded answers 409. The published contract of the
// route is built from its @ApiResponse metadata, so the status the route answers must be listed there.
describe('PATCH /integration/plugins/:pluginId/instances/:instanceId documents its 409', () => {
  it('answers 409 for a config write while the plugin is not loaded, and publishes that status', async () => {
    const update = jest.fn();
    const instances = {
      resolve: jest.fn().mockResolvedValue({
        id: 'chatwoot-adapter:acct1',
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct1',
        sessionScope: 'sess-1',
        secret: 's',
        verifyToken: null,
        config: {},
        enabled: true,
      }),
      update,
    } as unknown as PluginInstanceService;
    const loader = { getPlugin: jest.fn().mockReturnValue(undefined) } as unknown as PluginLoaderService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      { logInfo: jest.fn() } as unknown as AuditService,
      { applyScopeBinding: jest.fn() } as unknown as ScopeBindingService,
    );

    await expect(
      controller.patch('chatwoot-adapter', 'acct1', { enabled: false, config: { baseUrl: 'https://x' } }),
    ).rejects.toThrow(ConflictException);
    // Nothing of the body is written, `enabled` included.
    expect(update).not.toHaveBeenCalled();

    const handler = Object.getOwnPropertyDescriptor(IntegrationInstanceController.prototype, 'patch')?.value as object;
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) as Record<string, unknown>;
    expect(Object.keys(responses)).toContain('409');
  });
});
