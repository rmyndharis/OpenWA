import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService } from '../auth.service';
import { ChatScopeService } from '../chat-scope.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';
import { AuditService } from '../../audit/audit.service';
import {
  CAPABILITIES_KEY,
  CAPABILITY_AGNOSTIC_KEY,
  PUBLIC_KEY,
  REQUIRED_ROLE_KEY,
  UNRESTRICTED_KEY,
} from '../decorators/auth.decorators';
import { ApiKeyCapability } from '../api-key-permissions';

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'uuid-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_xxxx',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
    allowedChats: null,
    deniedPermissions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockContext(): ExecutionContext {
  const request = {
    headers: { 'x-api-key': 'k' },
    params: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    query: {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard blocked capabilities', () => {
  let guard: ApiKeyGuard;
  let authService: jest.Mocked<Partial<AuthService>>;
  let metadata: Record<string, unknown>;

  /** Reflector metadata is read by key, so every test states only the marks it cares about. */
  const authorize = async (apiKey: ApiKey, marks: Record<string, unknown>) => {
    metadata = { [PUBLIC_KEY]: false, ...marks };
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    return guard.canActivate(createMockContext());
  };

  beforeEach(() => {
    metadata = {};
    authService = {
      validateApiKey: jest.fn(),
      hasPermission: jest.fn().mockReturnValue(true),
    };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    } as unknown as jest.Mocked<Reflector>;
    const configService = { get: jest.fn().mockReturnValue([]) } as unknown as ConfigService;
    const auditService = { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService;
    guard = new ApiKeyGuard(authService as AuthService, reflector, configService, auditService, new ChatScopeService());
  });

  it('leaves a key with nothing blocked on its role alone, on a tagged route and an untagged one', async () => {
    const key = createMockApiKey();
    await expect(authorize(key, {})).resolves.toBe(true);
    await expect(authorize(key, { [CAPABILITIES_KEY]: [ApiKeyCapability.MESSAGES_SEND] })).resolves.toBe(true);
  });

  it('admits a key that blocks something else on a tagged route', async () => {
    const key = createMockApiKey({ deniedPermissions: [ApiKeyCapability.MESSAGES_READ] });

    await expect(authorize(key, { [CAPABILITIES_KEY]: [ApiKeyCapability.MESSAGES_SEND] })).resolves.toBe(true);
  });

  it('refuses a route tagged with a blocked capability', async () => {
    const key = createMockApiKey({ deniedPermissions: [ApiKeyCapability.MESSAGES_READ] });

    await expect(authorize(key, { [CAPABILITIES_KEY]: [ApiKeyCapability.MESSAGES_READ] })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(authorize(key, { [CAPABILITIES_KEY]: [ApiKeyCapability.MESSAGES_READ] })).rejects.toThrow(
      'API key is blocked from this capability (messages:read)',
    );
  });

  it('refuses when ANY capability a route touches is blocked', async () => {
    const key = createMockApiKey({ deniedPermissions: [ApiKeyCapability.CONTACTS_READ] });

    await expect(
      authorize(key, {
        [CAPABILITIES_KEY]: [ApiKeyCapability.MESSAGES_SEND, ApiKeyCapability.CONTACTS_READ],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses an untagged route for a key with any blocked capability', async () => {
    const key = createMockApiKey({ deniedPermissions: Object.values(ApiKeyCapability) });

    await expect(authorize(key, {})).rejects.toThrow('Capability-restricted API keys are not permitted on this route');
  });

  it('allows an explicitly capability-agnostic self-check', async () => {
    const key = createMockApiKey({ deniedPermissions: [ApiKeyCapability.MESSAGES_READ] });

    await expect(authorize(key, { [CAPABILITY_AGNOSTIC_KEY]: true })).resolves.toBe(true);
  });

  it('requires a completely unrestricted key on authority-changing routes', async () => {
    const key = createMockApiKey({ deniedPermissions: [ApiKeyCapability.MESSAGES_READ] });

    await expect(
      authorize(key, {
        [CAPABILITIES_KEY]: [ApiKeyCapability.APIKEYS_MANAGE],
        [UNRESTRICTED_KEY]: true,
      }),
    ).rejects.toThrow('Restricted API keys are not permitted on this route');
  });

  it('keeps a session-scoped key, and refuses blocked capabilities, on a route that fences sessions itself', async () => {
    const marks = { [CAPABILITIES_KEY]: [ApiKeyCapability.INTEGRATIONS_MANAGE], [UNRESTRICTED_KEY]: 'capabilities' };

    await expect(authorize(createMockApiKey({ allowedSessions: ['sess-1'] }), marks)).resolves.toBe(true);
    await expect(
      authorize(createMockApiKey({ deniedPermissions: [ApiKeyCapability.MESSAGES_READ] }), marks),
    ).rejects.toThrow('Capability-restricted API keys are not permitted on this route');
  });

  it('still applies the role gate first: a viewer key cannot send whatever it blocks', async () => {
    (authService.hasPermission as jest.Mock).mockReturnValue(false);
    const key = createMockApiKey({ role: ApiKeyRole.VIEWER, deniedPermissions: [] });

    await expect(
      authorize(key, {
        [REQUIRED_ROLE_KEY]: ApiKeyRole.OPERATOR,
        [CAPABILITIES_KEY]: [ApiKeyCapability.MESSAGES_SEND],
      }),
    ).rejects.toThrow('Insufficient permissions. Required: operator');
  });
});
