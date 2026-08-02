import { Reflector } from '@nestjs/core';
import { PluginsController } from './plugins.controller';
import { REQUIRED_ROLE_KEY, UNSCOPED_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

describe('PluginsController authorization', () => {
  const reflector = new Reflector();

  // Plugin reads expose installed versions, non-secret config, and health/error text — privileged
  // inventory on par with the ADMIN-gated write routes and the infra controllers' convention. A
  // VIEWER/OPERATOR key (or a session-scoped key) must not be able to enumerate it via the raw API.
  const adminOnly = [
    'findAll',
    'findOne',
    'healthCheck',
    'enable',
    'disable',
    'updateConfig',
    'getConfigUi',
    'updateSessionConfig',
    'updateSessions',
  ] as const;

  it.each(adminOnly)('%s requires the ADMIN role', method => {
    // Metadata lookup key, never invoked.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = PluginsController.prototype[method];
    const role = reflector.get<ApiKeyRole | undefined>(REQUIRED_ROLE_KEY, handler);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });

  it('updateSessions requires an unrestricted key because updateSessions replaces the complete active set', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = PluginsController.prototype.updateSessions;
    expect(reflector.get<boolean>(UNSCOPED_KEY, handler)).toBe(true);
  });
});
