import { Reflector } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

// the audit log is a security event trail; without a role gate any active key (incl. a
// read-only VIEWER) could read the entire trail. It must require ADMIN, matching the infra
// secrets/export routes.
describe('AuditController access control', () => {
  it('GET /audit requires the ADMIN role', () => {
    // Read the handler off the prototype as an opaque object so the lint unbound-method rule
    // (which guards against detached method `this`) doesn't fire on a metadata-only lookup.
    const proto = AuditController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const role = new Reflector().get<ApiKeyRole | undefined>(REQUIRED_ROLE_KEY, proto.findAll);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });
});
