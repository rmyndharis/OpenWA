import 'reflect-metadata';
import { REQUIRED_ROLE_KEY } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';
import { IntegrationInstanceController } from '../integration/integration-instance.controller';
import { RedriveController } from '../integration/redrive.controller';

// The dashboard's client-side role (seeded from localStorage) is cosmetic UX only — the ACTUAL
// authorization boundary is the backend @RequireRole guard. These assertions lock that the sensitive
// ADMIN-only integration provisioning / redrive surfaces are role-gated server-side at the class level,
// so a tampered client role can never reach them regardless of what the browser claims.
describe('admin controller role coverage (server-side authorization is the real gate)', () => {
  it.each([
    ['IntegrationInstanceController', IntegrationInstanceController],
    ['RedriveController', RedriveController],
  ])('%s requires the ADMIN role at the class level', (_name, controller) => {
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller)).toBe(ApiKeyRole.ADMIN);
  });
});
