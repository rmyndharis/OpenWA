import 'reflect-metadata';
import type { Request } from 'express';
import { AuthController } from './auth.controller';
import { UNSCOPED_KEY } from './decorators/auth.decorators';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { ApiKey } from './entities/api-key.entity';
import { ApiKeyCapability } from './api-key-permissions';
import type { AuthService } from './auth.service';
import type { AuditService } from '../audit/audit.service';

// Key-lifecycle routes carry no session dimension, so the guard's allowedSessions fence can never
// bite on them — the class-level @RequireUnscopedKey marker is what keeps a session-scoped ADMIN
// key from minting or widening credentials here. Lock that the marker stays on the controller.
describe('AuthController — scoped-key confinement marker', () => {
  it('requires unscoped keys at the class level', () => {
    expect(Reflect.getMetadata(UNSCOPED_KEY, AuthController)).toBe(true);
  });
});

// Every route that loads a key by id answers 404 for an unknown one, and every route with a body
// answers 400 on validation: the contract must say so, or a generated client has no case for them.
describe('AuthController OpenAPI error responses', () => {
  const declared = (handler: keyof AuthController) =>
    Object.keys(
      (Reflect.getMetadata(
        'swagger/apiResponse',
        Object.getOwnPropertyDescriptor(AuthController.prototype, handler)?.value as object,
      ) ?? {}) as Record<string, unknown>,
    );

  it.each(['findOne', 'update', 'delete', 'revoke'] as const)('declares 404 on %s', handler => {
    expect(declared(handler)).toContain('404');
  });

  it.each(['create', 'update'] as const)('declares 400 on %s', handler => {
    expect(declared(handler)).toContain('400');
  });
});

// API-key lifecycle operations (create / delete / revoke) must leave an audit trail — they were
// previously unrecorded. These assert the controller emits the matching audit action with the acting
// admin key, the resolved client IP, and the target key in metadata.
describe('AuthController — API-key lifecycle audit logging', () => {
  const actor = { id: 'admin-key', name: 'admin' } as unknown as ApiKey;
  const makeReq = (): Request =>
    ({ method: 'POST', path: '/auth/api-keys', clientIp: '203.0.113.7' }) as unknown as Request;

  let authService: {
    createApiKey: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    revoke: jest.Mock;
  };
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
      findOne: jest.fn().mockResolvedValue({
        id: 'k1',
        name: 'target-key',
        role: 'viewer',
        allowedIps: null,
        allowedSessions: null,
        expiresAt: null,
      }),
      update: jest.fn().mockResolvedValue({ ...createdKey, role: 'admin' }),
      delete: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue({ ...createdKey, isActive: false }),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(null) };
    controller = new AuthController(authService as unknown as AuthService, auditService as unknown as AuditService);
  });

  const lastContextFor = (
    action: AuditAction,
  ):
    | {
        apiKey?: ApiKey;
        ipAddress?: string;
        metadata?: {
          targetKeyId?: string;
          role?: string;
          scope?: unknown;
          before?: { role?: string };
          after?: { role?: string };
        };
      }
    | undefined => {
    const calls = auditService.logInfo.mock.calls as Array<
      [
        AuditAction,
        {
          apiKey?: ApiKey;
          ipAddress?: string;
          metadata?: {
            targetKeyId?: string;
            role?: string;
            scope?: unknown;
            before?: { role?: string };
            after?: { role?: string };
          };
        },
      ]
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
    expect(JSON.stringify(auditService.logInfo.mock.calls)).not.toContain('raw-secret');
  });

  it('inherits every capability blocked on the acting key when creating a key', async () => {
    const restrictedActor = {
      ...actor,
      deniedPermissions: [ApiKeyCapability.MESSAGES_READ],
    } as ApiKey;

    await controller.create(
      { name: 'new-key', deniedPermissions: [ApiKeyCapability.SESSIONS_CREATE] },
      makeReq(),
      restrictedActor,
    );

    expect(authService.createApiKey).toHaveBeenCalledWith({
      name: 'new-key',
      deniedPermissions: [ApiKeyCapability.SESSIONS_CREATE, ApiKeyCapability.MESSAGES_READ],
    });
  });

  it("records the created key's full authorization scope on API_KEY_CREATED", async () => {
    const expiresAt = new Date('2027-01-01T00:00:00Z');
    authService.createApiKey.mockResolvedValue({
      apiKey: {
        id: 'k2',
        name: 'scoped',
        role: 'operator',
        allowedIps: ['10.0.0.1'],
        allowedSessions: ['s1'],
        allowedChats: ['628123@c.us'],
        expiresAt,
      },
      rawKey: 'raw-secret',
    });
    await controller.create({ name: 'scoped' }, makeReq(), actor);
    const metadata = lastContextFor(AuditAction.API_KEY_CREATED)?.metadata;
    expect(metadata?.role).toBe('operator');
    expect(metadata?.scope).toEqual({
      role: 'operator',
      allowedIps: ['10.0.0.1'],
      allowedSessions: ['s1'],
      allowedChats: ['628123@c.us'],
      expiresAt,
    });
  });

  it('logs API_KEY_DELETED on delete', async () => {
    await controller.delete('k1', makeReq(), actor);
    expect(authService.delete).toHaveBeenCalledWith('k1');
    expect(lastContextFor(AuditAction.API_KEY_DELETED)?.metadata?.targetKeyId).toBe('k1');
  });

  it('logs API_KEY_UPDATED with before/after authorization state', async () => {
    await controller.update('k1', { role: 'admin' } as never, makeReq(), actor);
    const ctx = lastContextFor(AuditAction.API_KEY_UPDATED);
    expect(ctx?.apiKey).toBe(actor);
    expect(ctx?.metadata?.targetKeyId).toBe('k1');
    expect(ctx?.metadata?.before?.role).toBe('viewer');
    expect(ctx?.metadata?.after?.role).toBe('admin');
  });

  it("adds the acting key's blocked capabilities when updating another key", async () => {
    const restrictedActor = {
      ...actor,
      deniedPermissions: [ApiKeyCapability.MESSAGES_READ],
    } as ApiKey;
    authService.findOne.mockResolvedValueOnce({
      id: 'k1',
      deniedPermissions: [ApiKeyCapability.SESSIONS_CREATE],
    });

    await controller.update('k1', { name: 'renamed' }, makeReq(), restrictedActor);

    expect(authService.update).toHaveBeenCalledWith('k1', {
      name: 'renamed',
      deniedPermissions: [ApiKeyCapability.SESSIONS_CREATE, ApiKeyCapability.MESSAGES_READ],
    });
  });

  it('does not let a capability-restricted key change its own blocked capabilities', async () => {
    const restrictedActor = {
      ...actor,
      id: 'k1',
      deniedPermissions: [ApiKeyCapability.MESSAGES_READ],
    } as ApiKey;
    authService.findOne.mockResolvedValueOnce(restrictedActor);

    await expect(controller.update('k1', { deniedPermissions: [] }, makeReq(), restrictedActor)).rejects.toThrow(
      'cannot change its own blocked capabilities',
    );
    expect(authService.update).not.toHaveBeenCalled();
  });

  it('logs API_KEY_REVOKED on revoke', async () => {
    await controller.revoke('k1', makeReq(), actor);
    expect(lastContextFor(AuditAction.API_KEY_REVOKED)?.metadata?.targetKeyId).toBe('k1');
  });
});

// A key stored before expiresAt was validated can hold an unparseable expiry, which SQLite reads back as
// an Invalid Date. The gateway refuses such a key as expired, so every response must report it as expired
// too, not serialize the expiry as null (no expiry) and leave the key looking active.
describe('AuthController: unparseable stored expiry', () => {
  const stored = {
    id: 'k1',
    name: 'legacy',
    keyPrefix: 'ow_',
    role: 'user',
    isActive: true,
    usageCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-W40-1'),
  } as unknown as ApiKey;
  const epoch = '1970-01-01T00:00:00.000Z';
  const makeReq = (): Request => ({ method: 'PUT', path: '/auth/api-keys/k1' }) as unknown as Request;

  let authService: Record<'createApiKey' | 'findAll' | 'findOne' | 'update' | 'revoke', jest.Mock>;
  let auditService: { logInfo: jest.Mock };
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      createApiKey: jest.fn().mockResolvedValue({ apiKey: stored, rawKey: 'raw' }),
      findAll: jest.fn().mockResolvedValue([stored]),
      findOne: jest.fn().mockResolvedValue(stored),
      update: jest.fn().mockResolvedValue(stored),
      revoke: jest.fn().mockResolvedValue(stored),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(null) };
    controller = new AuthController(authService as unknown as AuthService, auditService as unknown as AuditService);
  });

  it('records the expiry as a past instant in the audited scope', async () => {
    await controller.create({ name: 'legacy' }, makeReq());
    await controller.update('k1', {}, makeReq());
    const [created, updated] = (
      JSON.parse(JSON.stringify(auditService.logInfo.mock.calls.map(call => (call as unknown[])[1]))) as {
        metadata: Record<string, { expiresAt: string | null }>;
      }[]
    ).map(ctx => ctx.metadata);
    expect(created.scope.expiresAt).toBe(epoch);
    expect(updated.before.expiresAt).toBe(epoch);
    expect(updated.after.expiresAt).toBe(epoch);
  });

  it('reports the expiry as a past instant in every key response', async () => {
    const responses = [
      await controller.create({ name: 'legacy' }, makeReq()),
      ...(await controller.findAll()),
      await controller.findOne('k1'),
      await controller.update('k1', {}, makeReq()),
      await controller.revoke('k1', makeReq()),
    ];
    for (const res of responses) {
      expect((JSON.parse(JSON.stringify(res)) as { expiresAt?: string }).expiresAt).toBe(epoch);
    }
  });

  it('passes a valid expiry and an unset one through unchanged', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00Z');
    authService.findOne.mockResolvedValueOnce({ ...stored, expiresAt });
    expect((await controller.findOne('k1')).expiresAt).toBe(expiresAt);
    authService.findOne.mockResolvedValueOnce({ ...stored, expiresAt: null });
    expect((await controller.findOne('k1')).expiresAt).toBeUndefined();
  });
});
