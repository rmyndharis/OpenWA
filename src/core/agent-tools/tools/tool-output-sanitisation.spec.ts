/**
 * Tests for tool output sanitisation.
 * Each test documents a data-leak or schema bug that was present before the fix.
 */
import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { invokeTool } from '../tool-invoker';
import { webhookTools } from './webhook.tools';
import { sessionTools } from './session.tools';
import type { WebhookService } from '../../../modules/webhook/webhook.service';
import type { SessionService } from '../../../modules/session/session.service';
import type { AuthService } from '../../../modules/auth/auth.service';
import { handleToolError } from '../../../modules/mcp/tool-result';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuth(over: Partial<Record<string, unknown>> = {}): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null, ...over }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

/** Minimal webhook entity shape that carries the sensitive fields. */
function stubWebhookEntity() {
  return {
    id: 'wh-1',
    sessionId: 'sess-1',
    url: 'https://example.com/hook',
    events: ['message.received'],
    filters: null,
    active: true,
    retryCount: 3,
    lastTriggeredAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    // sensitive fields that MUST be stripped:
    secret: 'super-secret-hmac-key',
    headers: { Authorization: 'Bearer token123' },
  };
}

/** Minimal session entity shape that carries the sensitive fields. */
function stubSessionEntity() {
  return {
    id: 'sess-1',
    name: 'my-bot',
    status: 'ready' as never,
    phone: '628123456789',
    pushName: 'John',
    connectedAt: new Date('2024-01-01'),
    lastActiveAt: new Date('2024-01-02'),
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    lastError: null,
    // sensitive fields that MUST be stripped:
    config: { apiToken: 'secret-config-value' },
    proxyUrl: 'socks5://user:pass@proxy:1080',
  };
}

// ---------------------------------------------------------------------------
// FIX 1: webhook tools must not leak `secret` or `headers`
// ---------------------------------------------------------------------------

describe('FIX 1: webhook tools strip secret + headers', () => {
  const entity = stubWebhookEntity();

  it('WebhooksList output has no secret or headers keys', async () => {
    const webhookSvc = {
      findAll: jest.fn().mockResolvedValue([entity]),
    } as unknown as WebhookService;

    const tool = webhookTools(webhookSvc).find(t => t.name === 'WebhooksList')!;
    const auth = makeAuth();
    const result = (await invokeTool(tool, {}, 'key', auth as unknown as AuthService)) as object[];

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('secret');
    expect(result[0]).not.toHaveProperty('headers');
    expect(result[0]).toHaveProperty('id', 'wh-1');
  });

  it('WebhookFindBySession output has no secret or headers keys', async () => {
    const webhookSvc = {
      findBySession: jest.fn().mockResolvedValue([entity]),
    } as unknown as WebhookService;

    const tool = webhookTools(webhookSvc).find(t => t.name === 'WebhookFindBySession')!;
    const auth = makeAuth();
    const result = (await invokeTool(tool, { sessionId: 'sess-1' }, 'key', auth as unknown as AuthService)) as object[];

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('secret');
    expect(result[0]).not.toHaveProperty('headers');
  });

  it('WebhookFindOne output has no secret or headers keys', async () => {
    const webhookSvc = {
      findOne: jest.fn().mockResolvedValue(entity),
    } as unknown as WebhookService;

    const tool = webhookTools(webhookSvc).find(t => t.name === 'WebhookFindOne')!;
    const auth = makeAuth();
    const result = await invokeTool(
      tool,
      { sessionId: 'sess-1', webhookId: 'wh-1' },
      'key',
      auth as unknown as AuthService,
    );

    expect(result).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('headers');
    expect(result).toHaveProperty('id', 'wh-1');
  });
});

// ---------------------------------------------------------------------------
// FIX 2: session tools must not leak `config` or `proxyUrl`
// ---------------------------------------------------------------------------

describe('FIX 2: session tools strip config + proxyUrl', () => {
  const entity = stubSessionEntity();

  it('SessionFindOne output has no config or proxyUrl keys', async () => {
    const sessionSvc = {
      findOne: jest.fn().mockResolvedValue(entity),
    } as unknown as SessionService;

    const tool = sessionTools(sessionSvc).find(t => t.name === 'SessionFindOne')!;
    const auth = makeAuth();
    const result = await invokeTool(tool, { sessionId: 'sess-1' }, 'key', auth as unknown as AuthService);

    expect(result).not.toHaveProperty('config');
    expect(result).not.toHaveProperty('proxyUrl');
    expect(result).toHaveProperty('id', 'sess-1');
  });

  it('SessionFindAll output items have no config or proxyUrl keys', async () => {
    const sessionSvc = {
      findAll: jest.fn().mockResolvedValue([entity]),
    } as unknown as SessionService;

    const tool = sessionTools(sessionSvc).find(t => t.name === 'SessionFindAll')!;
    const auth = makeAuth();
    const result = (await invokeTool(tool, {}, 'key', auth as unknown as AuthService)) as object[];

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('config');
    expect(result[0]).not.toHaveProperty('proxyUrl');
  });
});

// ---------------------------------------------------------------------------
// FIX 5: empty sessionId must be rejected (scope-skip prevention)
// ---------------------------------------------------------------------------

describe('FIX 5: empty sessionId is rejected at validation', () => {
  it('a sessionScoped tool rejects sessionId: "" with BadRequestException', async () => {
    const sessionSvc = {
      findOne: jest.fn().mockResolvedValue(stubSessionEntity()),
    } as unknown as SessionService;

    const tool = sessionTools(sessionSvc).find(t => t.name === 'SessionFindOne')!;
    const auth = makeAuth();

    await expect(invokeTool(tool, { sessionId: '' }, 'key', auth as unknown as AuthService)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a webhook sessionScoped tool rejects sessionId: "" with BadRequestException', async () => {
    const webhookSvc = {
      findBySession: jest.fn().mockResolvedValue([]),
    } as unknown as WebhookService;

    const tool = webhookTools(webhookSvc).find(t => t.name === 'WebhookFindBySession')!;
    const auth = makeAuth();

    await expect(invokeTool(tool, { sessionId: '' }, 'key', auth as unknown as AuthService)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ---------------------------------------------------------------------------
// FIX 6: non-HTTP errors must not leak raw error.message on the wire
// ---------------------------------------------------------------------------

describe('FIX 6: handleToolError sanitises non-HTTP errors', () => {
  it('a plain Error yields a generic wire message, not the raw text', () => {
    const result = handleToolError(new Error('db connection string leaked: postgres://secret@host/db'));
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { message: string };
    expect(payload.message).toBe('Internal error');
    expect(payload.message).not.toContain('postgres');
  });

  it('an HttpException keeps its client-safe message', () => {
    const err = new HttpException('Session not found', 404);
    const result = handleToolError(err);
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { message: string };
    expect(payload.message).toBe('Session not found');
  });

  it('an UnauthorizedException keeps its message', () => {
    const err = new UnauthorizedException('Missing API key');
    const result = handleToolError(err);
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { message: string };
    expect(payload.message).toBe('Missing API key');
  });
});

// ---------------------------------------------------------------------------
// FIX 7: BadRequestException with string-array detail must expose the array,
//         not the generic 'Bad Request Exception' string
// ---------------------------------------------------------------------------

describe('FIX 7: handleToolError exposes structured BadRequestException detail', () => {
  it('BadRequestException with string[] detail returns the array, not the generic string', () => {
    const err = new BadRequestException(['sessionId: too small', 'limit: max 100']);
    const result = handleToolError(err);
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { success: boolean; name: string; message: unknown };

    expect(payload.success).toBe(false);
    expect(payload.message).not.toBe('Bad Request Exception');
    expect(Array.isArray(payload.message)).toBe(true);
    expect(payload.message).toContain('sessionId: too small');
    expect(payload.message).toContain('limit: max 100');
  });

  it('BadRequestException with a plain string stays as that string', () => {
    const err = new BadRequestException('Session x not found');
    const result = handleToolError(err);
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { message: unknown };
    expect(payload.message).toBe('Session x not found');
  });

  it('NotFoundException with a plain string stays as that string', () => {
    const err = new BadRequestException('Session x not found');
    const result = handleToolError(err);
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { message: unknown };
    expect(payload.message).toBe('Session x not found');
  });

  it('plain Error still yields Internal error (no leakage)', () => {
    const result = handleToolError(new Error('db secret leaked'));
    const content = (result.content[0] as { type: string; text: string }).text;
    const payload = JSON.parse(content) as { message: unknown };
    expect(payload.message).toBe('Internal error');
  });

  it('result is marked isError=true', () => {
    const err = new BadRequestException(['sessionId: too small']);
    const result = handleToolError(err);
    expect(result.isError).toBe(true);
  });
});
