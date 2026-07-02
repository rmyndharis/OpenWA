import { Reflector } from '@nestjs/core';
import { RedriveController } from './redrive.controller';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';

describe('RedriveController authz', () => {
  it('is ADMIN-gated (re-dispatching DLQ payloads can cause real sends; a VIEWER/OPERATOR key must not)', () => {
    // The ApiKeyGuard only enforces a role when REQUIRED_ROLE_KEY metadata is present; without this
    // decorator any authenticated key (incl. read-only VIEWER) could POST the redrive action.
    const role = new Reflector().get<ApiKeyRole>(REQUIRED_ROLE_KEY, RedriveController);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });
});
