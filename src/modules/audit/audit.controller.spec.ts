import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditAction, AuditSeverity } from './entities/audit-log.entity';
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

// ?action=a&action=b reaches the handler as an array (an enum-typed query param is left alone by the
// global pipe) and bound as one SQL parameter it failed with a driver error, a 500. An unknown value
// silently matched nothing. Both are a malformed filter, so both answer 400.
describe('AuditController filter validation', () => {
  const findAll = jest.fn().mockResolvedValue({ data: [], total: 0 });
  const controller = new AuditController({ findAll } as unknown as AuditService);

  beforeEach(() => findAll.mockClear());

  it('rejects a repeated action or severity with 400', async () => {
    await expect(
      controller.findAll(undefined, [AuditAction.SESSION_CREATED, AuditAction.SESSION_DELETED] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.findAll(undefined, undefined, [AuditSeverity.INFO, AuditSeverity.WARN] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('rejects an unknown action or severity with 400', async () => {
    await expect(controller.findAll(undefined, 'nope' as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.findAll(undefined, undefined, 'fatal' as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findAll).not.toHaveBeenCalled();
  });

  it('passes a known action and severity through', async () => {
    await controller.findAll(undefined, AuditAction.SESSION_CREATED, AuditSeverity.WARN);
    expect(findAll).toHaveBeenCalledWith(
      { action: AuditAction.SESSION_CREATED, severity: AuditSeverity.WARN },
      undefined,
    );
  });

  // Dropping the apiKeyId pass-through would make ?apiKeyId= silently return every key's rows.
  it('passes the sessionId and apiKeyId filters through, and parses limit and offset as integers', async () => {
    await controller.findAll(undefined, undefined, undefined, 's1', 'key-1', '25', '50');
    expect(findAll).toHaveBeenCalledWith({ sessionId: 's1', apiKeyId: 'key-1', limit: 25, offset: 50 }, undefined);
  });
});
