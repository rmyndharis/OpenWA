// Enable the MCP server before AppModule is imported.
process.env.MCP_ENABLED = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { applyGlobalValidation } from '../src/config/app-validation';
import { LoggerService } from '../src/common/services/logger.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '../src/modules/mcp/mcp.server';
import { TOOL_ERROR_TEXT_MAX_CHARS } from '../src/modules/mcp/tool-result';

// test/mcp-auth.e2e-spec.ts boots the app the way a unit would, without configureApp(), so nothing else in CI
// runs /mcp behind the middleware main.ts installs: the request id, the security headers, the body parsers
// with their size and nesting caps. This file boots it the way main.ts does and checks what only that stack
// can break, plus the cap on the text of a tool error end to end.

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

const rpc = (method: string, params: Record<string, unknown>, id = 1) => ({ jsonrpc: '2.0', method, params, id });

/** The transport answers `text/event-stream`: `event: message` then a `data:` line holding the JSON-RPC reply. */
function reply(res: { body: unknown; text: string }): { result?: Record<string, unknown> } {
  if (typeof res.body === 'object' && res.body !== null && Object.keys(res.body).length > 0) return res.body;
  const data = /^data:\s*(.+)$/m.exec(res.text ?? '');
  return data ? (JSON.parse(data[1]) as { result?: Record<string, unknown> }) : {};
}

/** The text of the first content block of a tool result. */
function toolText(res: { body: unknown; text: string }): string {
  const content = reply(res).result?.content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.text ?? '';
}

describe('MCP behind the production middleware stack (e2e)', () => {
  let app: INestApplication<App>;
  let operatorKey: string;
  let scopedKey: string;
  const scopedSession = '11111111-1111-4111-8111-111111111111';
  const previousReadOnly = process.env.MCP_READONLY;

  const call = (key: string, name: string, args: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', key)
      .send(rpc('tools/call', { name, arguments: args }));

  beforeAll(async () => {
    // Write tools are only mounted with MCP_READONLY=false; read at mount, so before init.
    process.env.MCP_READONLY = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // `bodyParser: false` matches main.ts: configureApp installs the only parsers.
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    applyGlobalValidation(app);
    await app.init();

    const authService = app.get(AuthService);
    operatorKey = (await authService.createApiKey({ name: 'e2e-stack-operator', role: ApiKeyRole.OPERATOR })).rawKey;
    scopedKey = (
      await authService.createApiKey({
        name: 'e2e-stack-scoped',
        role: ApiKeyRole.OPERATOR,
        allowedSessions: [scopedSession],
      })
    ).rawKey;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (previousReadOnly === undefined) delete process.env.MCP_READONLY;
    else process.env.MCP_READONLY = previousReadOnly;
  });

  it('answers behind the request-context middleware and still requires a key', async () => {
    const withKey = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', operatorKey)
      .send(rpc('tools/list', {}));
    expect(withKey.status).toBe(200);
    expect(withKey.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{1,128}$/);

    const withoutKey = await request(app.getHttpServer()).post('/mcp').set(MCP_HEADERS).send(rpc('tools/list', {}));
    expect(withoutKey.status).toBe(401);
  });

  it('publishes the optional fields the REST routes take', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', operatorKey)
      .send(rpc('tools/list', {}));
    const tools = reply(res).result?.tools as Array<{
      name: string;
      inputSchema: { properties: object; additionalProperties?: boolean };
    }>;
    const properties = (name: string): string[] =>
      Object.keys(tools.find(t => t.name === name)?.inputSchema.properties ?? {});

    // Every input says it takes no other argument, and the call below holds the server to it.
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(t => t.inputSchema.additionalProperties === false)).toBe(true);
    expect(properties('MessageSendTemplate')).toContain('linkPreview');
    expect(properties('MessageSendText')).toContain('linkPreview');
    expect(properties('MessageList')).toContain('inlineMedia');
    expect(properties('MessageSendText')).toContain('idempotencyKey');
    expect(properties('MessageReact')).not.toContain('idempotencyKey');
  });

  it('runs a read tool end to end', async () => {
    const res = await call(operatorKey, 'SessionFindAll', {});
    expect(res.status).toBe(200);
    expect(JSON.parse(toolText(res))).toEqual(expect.any(Array));
  });

  it('refuses an argument a tool does not name, in a short answer however long its name is', async () => {
    const unknown = await call(operatorKey, 'SessionFindAll', { bogus: 1 });
    expect(toolText(unknown)).toContain('Unrecognized key: "bogus"');

    const long = await call(operatorKey, 'SessionFindAll', { ['k'.repeat(1_000_000)]: 1 });
    expect(toolText(long)).toContain('Unrecognized key');
    expect(long.text.length).toBeLessThan(1000);
  });

  it('refuses a call whose arguments hold more than the element cap, before it validates any of them', async () => {
    // A wrong value in a map costs one issue line per entry once the schema runs, so a wide map is cut off first.
    const withVars = (entries: number) => ({
      sessionId: scopedSession,
      chatId: '628111000111@c.us',
      templateId: 'x',
      vars: Object.fromEntries(Array.from({ length: entries }, (_, i) => [`v${i}`, 1])),
    });

    const over = await call(operatorKey, 'MessageSendTemplate', withVars(MCP_MAX_TOOL_INPUT_ELEMENTS));
    expect(toolText(over)).toContain(`more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`);
    expect(over.text.length).toBeLessThan(1000);

    const within = await call(operatorKey, 'MessageSendTemplate', withVars(50));
    expect(toolText(within)).toContain('expected string, received number');
  });

  it('claims a send idempotencyKey in the real store and frees it when the send is refused', async () => {
    const args = {
      sessionId: '44444444-4444-4444-8444-444444444444',
      chatId: '628111@c.us',
      text: 'hi',
      idempotencyKey: 'e2e-send-key',
    };
    const first = JSON.parse(toolText(await call(operatorKey, 'MessageSendText', args))) as {
      name: string;
      code?: string;
    };
    // A refusal before anything reached WhatsApp frees the key, so other text under it is refused for the same
    // reason, not as a reused key (422) or as an outcome that may have been sent (409).
    const second = JSON.parse(toolText(await call(operatorKey, 'MessageSendText', { ...args, text: 'other' }))) as {
      name: string;
      code?: string;
    };

    expect(first.name).not.toBe('NotImplementedException');
    expect(first.code).toBeUndefined();
    expect(second.name).toBe(first.name);
    expect(second.code).toBeUndefined();
  });

  it('lists messages with the REST filters, and the service still validates them', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const filtered = await call(operatorKey, 'MessageList', {
      sessionId,
      direction: 'incoming',
      type: 'image',
      since: 0,
      until: 10,
      orderBy: 'timestamp',
    });
    expect(JSON.parse(toolText(filtered))).toMatchObject({ messages: [], total: 0 });

    const reversed = await call(operatorKey, 'MessageList', { sessionId, since: 10, until: 5 });
    expect(JSON.parse(toolText(reversed))).toMatchObject({ success: false, name: 'BadRequestException' });
  });

  it('answers 404 for a group list on an unknown session, as the REST route does', async () => {
    const unknownSession = '22222222-2222-4222-8222-222222222222';
    const res = await call(operatorKey, 'GroupFindAll', { sessionId: unknownSession });
    expect(JSON.parse(toolText(res))).toMatchObject({ success: false, name: 'NotFoundException' });

    const rest = await request(app.getHttpServer())
      .get(`/api/sessions/${unknownSession}/groups`)
      .set('X-API-Key', operatorKey);
    expect(rest.status).toBe(404);
  });

  describe('a refusal that names an id the caller sent', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      // Recorded and silenced: each capped line is still about 4 KB.
      warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    // Each call names the key's own session, so it passes the session gate and the id under test reaches the
    // service, which puts it in its refusal.
    it.each([
      ['GroupFindOne', 'groupId', { sessionId: scopedSession }],
      ['GroupGetInviteCode', 'groupId', { sessionId: scopedSession }],
      ['ContactCheckNumber', 'number', { sessionId: scopedSession }],
      ['WebhookFindOne', 'webhookId', { sessionId: scopedSession }],
      ['AutomationRuleFindOne', 'ruleId', { sessionId: scopedSession }],
    ])('%s: a 1 MB %s comes back cut, in the answer and in the log', async (tool, field, base) => {
      const id = 'x'.repeat(1_000_000);
      const res = await call(scopedKey, tool, { ...base, [field]: id });

      expect(res.status).toBe(200);
      const answer = JSON.parse(toolText(res)) as { success: boolean; message: string };
      expect(answer.success).toBe(false);
      expect(answer.message.length).toBeLessThan(TOOL_ERROR_TEXT_MAX_CHARS + 100);
      expect(answer.message).toContain('[truncated, ');
      expect(res.text.length).toBeLessThan(TOOL_ERROR_TEXT_MAX_CHARS + 1000);

      const logged = warn.mock.calls
        .map(call => String((call as unknown[])[0]))
        .filter(line => line.includes('MCP tool error'));
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) expect(line.length).toBeLessThan(TOOL_ERROR_TEXT_MAX_CHARS + 150);
    });

    it('keeps a short refusal whole', async () => {
      const res = await call(scopedKey, 'WebhookFindOne', { sessionId: scopedSession, webhookId: 'missing' });
      const answer = JSON.parse(toolText(res)) as { message: string };
      expect(answer.message).toBe("Webhook with id 'missing' not found");
    });
  });
});
