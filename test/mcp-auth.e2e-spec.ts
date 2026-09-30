// archiver v8 is ESM-only; stub it so ts-jest can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Enable the MCP server before AppModule is imported.
process.env.MCP_ENABLED = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';

// --- MCP protocol helpers ---

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function jsonRpcRequest(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: '2.0', method, params, id };
}

/**
 * Parse the MCP response. The StreamableHTTP transport sends:
 *   - `text/event-stream` SSE for normal requests (tools/list, tools/call)
 *   - `application/json` directly for some responses
 *
 * Supertest parses `application/json` into `.body`. For SSE, `.body` is empty
 * and the actual content is in `.text` (raw string). We try both.
 */
function parseMcpResponse(res: { body: unknown; text: string }): Record<string, unknown> {
  // If supertest parsed JSON, body will be a non-empty object
  if (typeof res.body === 'object' && res.body !== null && Object.keys(res.body).length > 0) {
    return res.body as Record<string, unknown>;
  }
  // SSE format: "event: message\ndata: {...}\n\n" — extract the data line
  const text = res.text ?? '';
  const match = /^data:\s*(.+)$/m.exec(text);
  if (match) {
    return JSON.parse(match[1]) as Record<string, unknown>;
  }
  // Plain JSON text fallback
  if (text.trim().startsWith('{')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return {};
}

// --- Test suite ---

describe('MCP server (e2e)', () => {
  let app: INestApplication<App>;
  let viewerKey: string;
  let chatKey: string;
  let ipKey: string;
  const initialize = () =>
    jsonRpcRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const authService = app.get(AuthService);
    viewerKey = (await authService.createApiKey({ name: 'e2e-mcp-viewer', role: ApiKeyRole.VIEWER })).rawKey;
    chatKey = (
      await authService.createApiKey({ name: 'e2e-mcp-chat', role: ApiKeyRole.VIEWER, allowedChats: ['628123@c.us'] })
    ).rawKey;
    ipKey = (await authService.createApiKey({ name: 'e2e-mcp-ip', role: ApiKeyRole.VIEWER, allowedIps: ['127.0.0.1'] }))
      .rawKey;
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore TypeORM multi-datasource teardown quirk */
    }
  });

  // ---------------------------------------------------------------------------
  // 1. MCP endpoint is reachable with a key: initialize succeeds
  // ---------------------------------------------------------------------------
  it('POST /mcp with initialize request responds with 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', viewerKey)
      .send(initialize());

    expect([200, 202]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // 2. tools/list returns the tool catalogue with known names
  // ---------------------------------------------------------------------------
  it('tools/list returns the tool catalogue', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('Authorization', `Bearer ${viewerKey}`)
      .send(jsonRpcRequest('tools/list'));

    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = body.result as Record<string, unknown> | undefined;
    expect(result).toBeDefined();
    const tools = result?.tools as Array<{ name: string }> | undefined;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools!.length).toBeGreaterThan(0);
    // Verify well-known tools are present
    const names = tools!.map(t => t.name);
    expect(names).toContain('SessionFindAll');
  });

  // ---------------------------------------------------------------------------
  // 3. Every request needs a valid key: nothing is answered before it
  // ---------------------------------------------------------------------------
  it('initialize without a key answers 401 and discloses no server info', async () => {
    const res = await request(app.getHttpServer()).post('/mcp').set(MCP_HEADERS).send(initialize());

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing API key' }, id: null });
    expect(res.text).not.toContain('serverInfo');
  });

  it('tools/list with an unknown key answers 401 and lists no tools', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', 'owa_k1_not-a-real-key')
      .send(jsonRpcRequest('tools/list'));

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('SessionFindAll');
  });

  it('tools/call without a key answers 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send(jsonRpcRequest('tools/call', { name: 'SessionFindAll', arguments: {} }));

    expect(res.status).toBe(401);
  });

  it('refuses a key with an IP allow-list at the gate, as every MCP tool call does', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', ipKey)
      .send(jsonRpcRequest('tools/list'));

    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  // Role, session and chat scope stay per tool call, answered in-band once the key passes the gate.
  it('a chat-restricted key passes the gate and is refused in-band by the tool call', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', chatKey)
      .send(jsonRpcRequest('tools/call', { name: 'SessionFindAll', arguments: {} }));

    expect(res.status).toBe(200);
    const result = parseMcpResponse(res).result as Record<string, unknown> | undefined;
    expect(result?.isError).toBe(true);
    const content = result?.content as Array<{ type: string; text?: string }> | undefined;
    expect(content?.find(c => c.type === 'text')?.text ?? '').toMatch(/restricted to selected chats/i);
  });

  // ---------------------------------------------------------------------------
  // 4. Unsupported Content-Type → 415
  // ---------------------------------------------------------------------------
  it('POST /mcp with wrong Content-Type returns 415', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set({ 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' })
      .set('X-API-Key', viewerKey)
      .send('{}');

    expect(res.status).toBe(415);
  });

  // ---------------------------------------------------------------------------
  // 4b. GET / DELETE: the stateless transport offers no SSE stream and no session,
  //     so both answer 405 (an SDK client treats anything else as an error)
  // ---------------------------------------------------------------------------
  it('GET and DELETE /mcp answer 405 with Allow: POST', async () => {
    const server = app.getHttpServer();
    const get = await request(server).get('/mcp').set('Accept', 'text/event-stream');
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
    expect(get.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });

    const del = await request(server).delete('/mcp');
    expect(del.status).toBe(405);
    expect(del.headers['allow']).toBe('POST');
  });

  // ---------------------------------------------------------------------------
  // 5. MCP_READONLY mode — write tools hidden from catalogue
  //    Tested at integration level: the `readOnly` flag path in mcp.server.ts
  //    calls registry.list({ readOnly: true }), which is unit-tested in
  //    tool-registry.spec.ts. A second full app boot is not cost-effective here;
  //    we note the gap and mark as pending.
  // ---------------------------------------------------------------------------
  it.todo('MCP_READONLY=true hides write tools — requires second app boot');

  // ---------------------------------------------------------------------------
  // 6. Rate limiter at 429
  //    The per-key limiter is fully covered by mcp-rate-limit.spec.ts.
  //    Triggering it in e2e needs > 60 same-key tool calls in 60s, making the
  //    suite slow. The wiring (mountMcpServer → rateLimiter.check) is 3 lines
  //    with no branching. Marking as pending.
  // ---------------------------------------------------------------------------
  it.todo('rate limiter returns 429-equivalent tool error past cap — see mcp-rate-limit.spec.ts');

  // ---------------------------------------------------------------------------
  // 7. Session-scoped key scoping
  //    Requires a created session + a key with allowedSessions set. The full
  //    session lifecycle (QR scan, WhatsApp connect) is not automatable in e2e.
  //    Covered by invokeTool unit test (tool-invoker.spec.ts).
  // ---------------------------------------------------------------------------
  it.todo('session-scoped key calling another sessions tool is rejected — see tool-invoker.spec.ts');
});
