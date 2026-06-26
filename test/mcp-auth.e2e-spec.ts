// archiver v8 is ESM-only; stub it so ts-jest can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Enable the MCP server before AppModule is imported.
process.env.MCP_ENABLED = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore TypeORM multi-datasource teardown quirk */
    }
  });

  // ---------------------------------------------------------------------------
  // 1. MCP endpoint is reachable — initialize succeeds
  // ---------------------------------------------------------------------------
  it('POST /mcp with initialize request responds with 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send(
        jsonRpcRequest('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.1' },
        }),
      );

    expect([200, 202]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // 2. tools/list returns the tool catalogue with known names
  // ---------------------------------------------------------------------------
  it('tools/list returns the tool catalogue', async () => {
    const res = await request(app.getHttpServer()).post('/mcp').set(MCP_HEADERS).send(jsonRpcRequest('tools/list'));

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
  // 3. tools/call without API key returns an error tool result
  //    (auth is protocol-level: tool errors surface as isError=true, not HTTP 401)
  // ---------------------------------------------------------------------------
  it('tools/call without API key returns isError tool result', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send(
        jsonRpcRequest('tools/call', {
          name: 'SessionFindAll',
          arguments: {},
        }),
      );

    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    // The tool handler catches UnauthorizedException and routes through handleToolError,
    // returning a tool result with isError=true.
    const result = body.result as Record<string, unknown> | undefined;
    expect(result?.isError).toBe(true);
    const content = result?.content as Array<{ type: string; text?: string }> | undefined;
    expect(Array.isArray(content)).toBe(true);
    const text = content?.find(c => c.type === 'text')?.text ?? '';
    expect(text).toMatch(/unauthorized|missing api key/i);
  });

  // ---------------------------------------------------------------------------
  // 4. Unsupported Content-Type → 415
  // ---------------------------------------------------------------------------
  it('POST /mcp with wrong Content-Type returns 415', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set({ 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' })
      .send('{}');

    expect(res.status).toBe(415);
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
