import type { Request } from 'express';
import { AuthController } from './auth.controller';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { ApiKey } from './entities/api-key.entity';
import type { AuthService } from './auth.service';
import type { AuditService } from '../audit/audit.service';

// API-key lifecycle operations (create / delete / revoke) must leave an audit trail — they were
// previously unrecorded. These assert the controller emits the matching audit action with the acting
// admin key, the resolved client IP, and the target key in metadata.
describe('AuthController — API-key lifecycle audit logging', () => {
  const actor = { id: 'admin-key', name: 'admin' } as unknown as ApiKey;
  const makeReq = (): Request =>
    ({ method: 'POST', path: '/auth/api-keys', clientIp: '203.0.113.7' }) as unknown as Request;

  let authService: { createApiKey: jest.Mock; findOne: jest.Mock; delete: jest.Mock; revoke: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: AuthController;

  beforeEach(() => {
    const createdKey = {
      id: 'k1',
      name: 'new-key',
      role: 'user',
      keyPrefix: 'ow_',
      isActive: true,
      usageCount: 0,
      createdAt: new Date(),
    };
    authService = {
      createApiKey: jest.fn().mockResolvedValue({ apiKey: createdKey, rawKey: 'raw-secret' }),
      findOne: jest.fn().mockResolvedValue({ id: 'k1', name: 'target-key' }),
      delete: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue({ ...createdKey, isActive: false }),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(null) };
    controller = new AuthController(authService as unknown as AuthService, auditService as unknown as AuditService);
  });

  const lastContextFor = (
    action: AuditAction,
  ): { apiKey?: ApiKey; ipAddress?: string; metadata?: { targetKeyId?: string } } | undefined => {
    const calls = auditService.logInfo.mock.calls as Array<
      [AuditAction, { apiKey?: ApiKey; ipAddress?: string; metadata?: { targetKeyId?: string } }]
    >;
    return calls.find(c => c[0] === action)?.[1];
  };

  it('logs API_KEY_CREATED on create, with the acting key, IP, and target id', async () => {
    await controller.create({ name: 'new-key' }, makeReq(), actor);
    const ctx = lastContextFor(AuditAction.API_KEY_CREATED);
    expect(ctx).toBeDefined();
    expect(ctx?.apiKey).toBe(actor);
    expect(ctx?.ipAddress).toBe('203.0.113.7');
    expect(ctx?.metadata?.targetKeyId).toBe('k1');
  });

  it('logs API_KEY_DELETED on delete', async () => {
    await controller.delete('k1', makeReq(), actor);
    expect(authService.delete).toHaveBeenCalledWith('k1');
    expect(lastContextFor(AuditAction.API_KEY_DELETED)?.metadata?.targetKeyId).toBe('k1');
  });

  it('logs API_KEY_REVOKED on revoke', async () => {
    await controller.revoke('k1', makeReq(), actor);
    expect(lastContextFor(AuditAction.API_KEY_REVOKED)?.metadata?.targetKeyId).toBe('k1');
  });
});
