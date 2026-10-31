import {
  Module,
  INestApplication,
  Controller,
  Post,
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  All,
  Req,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Request } from 'express';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureApp } from '../src/configure-app';
import { applyGlobalValidation } from '../src/config/app-validation';
import { DASHBOARD_CSP_NONCE_PLACEHOLDER } from '../src/config/dashboard-csp';
import { ActiveKeyIndex } from '../src/modules/auth/active-key-index';
import { ShutdownService } from '../src/common/services/shutdown.service';
import { documentErrorResponses, ERROR_RESPONSE_SCHEMA } from '../src/config/swagger.config';
import * as bodyNesting from '../src/common/validation/body-nesting';
import { SendTextMessageDto } from '../src/modules/message/dto/send-message.dto';

/**
 * The production HTTP surface, run for real. Every other e2e builds a bare Nest app, so the stack
 * main.ts installs (nonce, helmet, body caps, CORS, the SPA document handler) was executed by
 * nothing, and the one suite that needed the document handler carried its own copy of it, minus the
 * nonce injection. These assertions fail if the copy and the original ever diverge again, because
 * there is no copy left to diverge.
 */
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { received: typeof body };
  }
}

/** A route with a real request DTO, so the global ValidationPipe runs class-transformer over the body. */
@Controller('validated')
class ValidatedController {
  @Post('text')
  text(@Body() dto: SendTextMessageDto) {
    return { chatId: dto.chatId };
  }
}

const deleted: string[] = [];

@Controller('sessions')
class SessionStubController {
  @Get(':sessionId')
  get(@Param('sessionId') sessionId: string) {
    return { id: sessionId };
  }

  @Delete(':sessionId')
  @HttpCode(204)
  remove(@Param('sessionId') sessionId: string) {
    deleted.push(sessionId);
  }
}

const ingressHits: string[] = [];

/** Same route shape as the real ingress controller, which forwards every method to a plugin. */
@Controller('ingress')
class IngressStubController {
  @All(':pluginId/:instanceId/*path')
  @HttpCode(202)
  receive(@Req() req: Request) {
    ingressHits.push(`${req.method} ${req.path}`);
  }
}

@Module({ controllers: [EchoController, ValidatedController, SessionStubController, IngressStubController] })
class HttpSurfaceModule {}

// A stand-in for the bundled document: the real dashboard/index.html carries the placeholder in a
// meta element, which Plugins.tsx reads to copy the nonce onto its sandboxed iframe's scripts.
const surfaceRoot = mkdtempSync(join(tmpdir(), 'openwa-surface-'));
const distDir = join(surfaceRoot, 'dashboard', 'dist');
mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, 'index.html'),
  `<!doctype html><html><head><meta name="openwa-csp-nonce" content="${DASHBOARD_CSP_NONCE_PLACEHOLDER}" />` +
    `</head><body><script nonce="${DASHBOARD_CSP_NONCE_PLACEHOLDER}"></script></body></html>`,
);
// The e2e globalTeardown sweeps only openwa-e2e-* entries, so this suite removes its own fixture.
afterAll(() => rmSync(surfaceRoot, { recursive: true, force: true }));

describe('production HTTP surface (configureApp)', () => {
  let app: INestApplication<App>;

  const previousBodyLimit = process.env.BODY_SIZE_LIMIT;
  const previousCorsOrigins = process.env.CORS_ORIGINS;

  beforeAll(async () => {
    // Pin the cap here rather than inheriting the lane's: configureApp reads it at call time, and a
    // suite that depends on ambient env asserts whatever the runner happened to set. 1mb makes the
    // aggregate budget 4mb (four times the per-request cap), so the two layers are separable.
    process.env.BODY_SIZE_LIMIT = '1mb';
    // Without an explicit allowlist the policy is a wildcard, which allows every origin and would
    // make the denial assertion below pass on any implementation.
    process.env.CORS_ORIGINS = 'https://allowed.example';
    // `bodyParser: false` matches main.ts: configureApp installs the only parsers, with the caps.
    app = await NestFactory.create<INestApplication<App>>(HttpSurfaceModule, { bodyParser: false, logger: false });
    configureApp(app, { dashboard: { distDir, enabled: true } });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousBodyLimit === undefined) delete process.env.BODY_SIZE_LIMIT;
    else process.env.BODY_SIZE_LIMIT = previousBodyLimit;
    if (previousCorsOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previousCorsOrigins;
  });

  it('serves a document whose nonce matches the one in its own CSP header', async () => {
    const res = await request(app.getHttpServer()).get('/').set('Accept', 'text/html').expect(200);

    const csp = res.headers['content-security-policy'];
    const fromHeader = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
    expect(fromHeader).toBeTruthy();
    // The document must carry THAT value, not a placeholder and not a different nonce: a mismatch
    // means the browser refuses every script the page declares.
    expect(res.text).toContain(`content="${fromHeader}"`);
    expect(res.text).toContain(`nonce="${fromHeader}"`);
    expect(res.text).not.toContain(DASHBOARD_CSP_NONCE_PLACEHOLDER);
  });

  it('gives each response its own nonce', async () => {
    const nonceOf = async (): Promise<string | undefined> => {
      const res = await request(app.getHttpServer()).get('/').set('Accept', 'text/html').expect(200);
      return /'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers['content-security-policy'])?.[1];
    };
    // A shared nonce would let one document's value satisfy another's CSP, which is the whole
    // reason the document is served dynamically rather than statically.
    expect(await nonceOf()).not.toEqual(await nonceOf());
  });

  it('allows styles and fonts only from its own origin', async () => {
    const res = await request(app.getHttpServer()).get('/').set('Accept', 'text/html').expect(200);

    const csp = res.headers['content-security-policy'];
    expect(csp).toMatch(/(?:^|;)font-src 'self'(?:;|$)/);
    expect(csp).toMatch(/(?:^|;)style-src 'self' 'unsafe-inline'(?:;|$)/);
  });

  it('echoes the CORS header for an allowed Origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://allowed.example')
      .send({});

    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
  });

  // Neither send-idempotency header is CORS-safelisted: a browser sends Idempotency-Key only if the preflight
  // lists it, and reads Idempotent-Replayed only if the response exposes it.
  const listed = (header: string | undefined): string[] => (header ?? '').split(',').map(name => name.trim());

  it('lists Idempotency-Key in the preflight answer for an allowed Origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/echo')
      .set('Origin', 'https://allowed.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'idempotency-key');

    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
    expect(listed(res.headers['access-control-allow-headers'])).toContain('Idempotency-Key');
  });

  it('exposes Idempotent-Replayed to an allowed Origin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://allowed.example')
      .send({});

    expect(listed(res.headers['access-control-expose-headers'])).toContain('Idempotent-Replayed');
  });

  it('denies a disallowed Origin by omitting the CORS headers, not by failing the request', async () => {
    // Deliberately an /api route: the document handler answers `/` before the CORS layer is
    // reached, so asserting the denial there passes whatever CORS does.
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://evil.example')
      .send({});

    // Throwing here surfaced as a 500 once (#250). The browser is what must block the response.
    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('admits a body under the per-request cap', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(900 * 1024) });

    expect(res.status).toBe(201);
  });

  // The recursive readers of a parsed body (class-transformer in the validation pipe, the send
  // idempotency fingerprint, the cluster proxy's JSON.stringify) overflow the stack a couple of thousand
  // levels down and answered 500 with a stack trace in the log. A chain of `levels` nested objects:
  // '{"a":{}}' is two.
  const nestedObjects = (levels: number): string => '{"a":'.repeat(levels - 1) + '{}' + '}'.repeat(levels - 1);

  // The documented limit is 100 levels, written as a literal here so that moving the cap fails a test.
  it('admits a body nested 100 levels and refuses 101 with 400', async () => {
    const post = (body: string) => request(app.getHttpServer()).post('/api/echo').type('json').send(body);

    expect((await post(nestedObjects(100))).status).toBe(201);

    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .type('json')
      .set('Origin', 'https://allowed.example')
      .send(nestedObjects(101))
      .expect(400);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Request body must not nest objects or arrays more than 100 levels deep',
    });
    expect(res.headers['x-request-id']).toBeDefined();
    // A browser can read the refusal only if it carries the CORS headers.
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
  });

  // The depth is read from the raw bytes, so the refusal does not wait for the parse: a body that is deeper than
  // the cap and never closes is refused for its depth, not for being invalid JSON.
  it('refuses a body for its depth before it is parsed', async () => {
    const res = await request(app.getHttpServer()).post('/api/echo').type('json').send('['.repeat(101));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Request body must not nest objects or arrays more than 100 levels deep',
    });
  });

  it('does not count brackets inside a string as nesting', async () => {
    const text = `${'['.repeat(5000)}\\"${'{'.repeat(5000)}`;
    const res = await request(app.getHttpServer()).post('/api/echo').type('json').send(`{"text":"${text}"}`);

    expect(res.status).toBe(201);
  });

  // Posts raw bytes with node's http client: supertest would turn a Buffer into JSON.
  const postBytes = async (contentType: string, bytes: Buffer): Promise<{ status: number; body: string }> => {
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/echo',
          method: 'POST',
          headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(bytes);
    });
  };
  const NESTING_MESSAGE = 'Request body must not nest objects or arrays more than 100 levels deep';

  // body-parser hands the charset to iconv-lite, which reads every one of these as UTF-8: it lower-cases the
  // name and drops every character that is not a letter or digit, and a trailing ':NNNN' year. A client must
  // not be able to pick the slow path by spelling UTF-8 differently, so each is refused for its depth before
  // the parse, like the plain spelling.
  it.each(['utf-8', 'UTF-8', 'utf-8.', 'utf-_8', 'utf--8', 'utf-8:1993', 'utf-8!'])(
    'scans a body declared as charset "%s" before it is parsed',
    async charset => {
      const res = await postBytes(`application/json; charset="${charset}"`, Buffer.from('['.repeat(101)));

      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ message: NESTING_MESSAGE });
    },
  );

  // The raw scan reads UTF-8. A body in another UTF charset is decoded by the parser first, so it is walked
  // after the parse instead and meets the same limit.
  it.each([
    [100, 201],
    [101, 400],
  ])('holds a UTF-16 body nested %i levels to the same limit (%i)', async (levels, status) => {
    const res = await postBytes('application/json; charset=utf-16le', Buffer.from(nestedObjects(levels), 'utf16le'));

    expect(res.status).toBe(status);
  });

  // In UTF-16 a backslash escapes only the first byte of the next character, so scanning its bytes as if they
  // were UTF-8 would read the quote after an escaped one as the end of the string and count the brackets that
  // follow as structure. The body below nests one level.
  it('does not scan the bytes of a UTF-16 body: an escaped quote and brackets inside its string are not nesting', async () => {
    const json = `{"t":"say \\"${'['.repeat(150)}"}`;
    const res = await postBytes('application/json; charset=utf-16le', Buffer.from(json, 'utf16le'));

    expect(res.status).toBe(201);
  });

  // A body the raw scan has read must not be walked again after the parse: that second pass is the cost the
  // scan exists to remove. A body in another charset has not been read and is walked once it is parsed.
  describe('the walk after the parse', () => {
    const walk = jest.spyOn(bodyNesting, 'exceedsBodyNesting');
    beforeEach(() => walk.mockClear());
    afterAll(() => walk.mockRestore());

    it('is skipped for a UTF-8 body that was scanned', async () => {
      await request(app.getHttpServer())
        .post('/api/echo')
        .type('json')
        .send({ small: [1, 2, 3] })
        .expect(201);

      expect(walk).not.toHaveBeenCalled();
    });

    it('runs on the parsed value of a UTF-16 body', async () => {
      const res = await postBytes('application/json; charset=utf-16le', Buffer.from('{"small":[1,2,3]}', 'utf16le'));

      expect(res.status).toBe(201);
      expect(walk).toHaveBeenCalled();
      expect(walk.mock.calls[0][0]).toEqual({ small: [1, 2, 3] });
    });
  });

  it('answers a DTO route 400, not 500, for a body nested thousands of levels deep', async () => {
    const mentions = '['.repeat(5000) + ']'.repeat(5000);
    const res = await request(app.getHttpServer())
      .post('/api/validated/text')
      .type('json')
      .send(`{"chatId":"628123456789@c.us","text":"hi","mentions":${mentions}}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('refuses a body over the per-request cap with 413', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(1100 * 1024) });

    expect(res.status).toBe(413);
  });

  it('sends the error field on a malformed-JSON 400 but not on the 413, as the ErrorResponse schema says', async () => {
    const malformed = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });

    const oversized = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(1100 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).not.toHaveProperty('error');

    const schema = documentErrorResponses({ openapi: '3.0.0', info: { title: 't', version: '0' }, paths: {} })
      .components?.schemas?.[ERROR_RESPONSE_SCHEMA] as { properties: { error: { description: string } } };
    const omittedOn = schema.properties.error.description.split('omits it')[1];
    expect(omittedOn).toContain('oversized-body 413');
    expect(omittedOn).not.toMatch(/malformed/i);
  });

  it('refuses a declared body the in-flight budget can never admit with 413, before reading it', async () => {
    // The budget is a PRE-guard: it answers on the DECLARED length, before the parser reads a byte,
    // which is what stops slow-body memory pinning that no route guard can reach. A declared size the
    // whole budget can never hold gets 413 without Retry-After, since retrying cannot help; a body that
    // fits once the budget frees gets 503 + Retry-After (the tiers suite below). Asserting it by
    // actually uploading an oversized body is timing-dependent: the server refuses and destroys
    // the socket while the client is still writing, so the client sees ECONNRESET instead of the
    // response often enough to flake. Declaring the size and sending almost nothing tests the same
    // decision deterministically.
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(8 * 1024 * 1024))
      // Bounded on purpose: if the guard ever stops refusing, the parser waits for a body that is
      // never coming and this hangs instead of failing. A hang is not a red.
      .timeout({ deadline: 5000, response: 5000 })
      .send('{}');

    expect(res.status).toBe(413);
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('refuses a DELETE whose path ends in a slash instead of matching the route without it', async () => {
    deleted.length = 0;
    for (const path of ['/api/sessions/abc/', '/api/sessions/abc/?x=1']) {
      const res = await request(app.getHttpServer()).delete(path).set('Origin', 'https://allowed.example').expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
      expect(res.headers['x-request-id']).toBeDefined();
      // A browser can read the refusal only if it carries the CORS headers; helmet's must be there too.
      expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
    expect(deleted).toEqual([]);

    await request(app.getHttpServer()).delete('/api/sessions/abc').expect(204);
    expect(deleted).toEqual(['abc']);
    // Other methods keep the lenient trailing-slash match.
    await request(app.getHttpServer()).get('/api/sessions/abc/').expect(200);
  });

  it('refuses a trailing-slash DELETE whatever the case of the prefix, as routing ignores it', async () => {
    deleted.length = 0;
    for (const path of ['/API/sessions/abc/', '/Api/sessions/abc/']) {
      await request(app.getHttpServer()).delete(path).expect(404);
    }
    expect(deleted).toEqual([]);
  });

  it('still delivers a trailing-slash DELETE to the ingress route', async () => {
    ingressHits.length = 0;
    await request(app.getHttpServer()).delete('/api/ingress/p/i/hook/').expect(202);
    await request(app.getHttpServer()).delete('/API/ingress/p/i/hook/').expect(202);
    expect(ingressHits).toEqual(['DELETE /api/ingress/p/i/hook/', 'DELETE /API/ingress/p/i/hook/']);
  });

  it('refuses a path or query that decodes to a NUL character before any route runs', async () => {
    ingressHits.length = 0;
    for (const path of ['/api/sessions/abc%00', '/api/sessions/abc?name=%00', '/api/ingress/p%00/i/hook']) {
      const res = await request(app.getHttpServer()).get(path).set('Origin', 'https://allowed.example').expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
    }
    expect(ingressHits).toEqual([]);
    // %2500 decodes to the text "%00", not to a NUL, so it still reaches the route.
    await request(app.getHttpServer()).get('/api/sessions/abc%2500').expect(200);
  });

  it('refuses a body holding a NUL character at any depth', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send({ items: [{ variables: { name: 'a\u0000b' } }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('answers a compressed body with 415 rather than charging the budget its inflated size', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('{}');

    expect(res.status).toBe(415);
  });

  it('answers every body rejection with the CORS, helmet and request-id headers', async () => {
    const post = () =>
      request(app.getHttpServer())
        .post('/api/echo')
        .set('Content-Type', 'application/json')
        .set('Origin', 'https://allowed.example');
    const rejections = [
      await post().send('{bad'),
      await post().send({ blob: 'x'.repeat(1100 * 1024) }),
      await post()
        .set('Content-Length', String(8 * 1024 * 1024))
        .timeout({ deadline: 5000, response: 5000 })
        .send('{}'),
      await post().set('Content-Encoding', 'gzip').send('{}'),
    ];

    expect(rejections.map(res => res.status)).toEqual([400, 413, 413, 415]);
    for (const res of rejections) {
      // Without the CORS header a cross-origin browser sees an opaque network error, not the status.
      expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});

describe('in-flight body budget tiers (configureApp)', () => {
  let app: INestApplication<App>;
  const previousBodyLimit = process.env.BODY_SIZE_LIMIT;

  // Stands in for the real index: only 'known-key' is an active key.
  const keyIndex = {
    recognise: (headers: { 'x-api-key'?: unknown }) => (headers['x-api-key'] === 'known-key' ? 'h' : undefined),
  };

  @Module({ controllers: [EchoController], providers: [{ provide: ActiveKeyIndex, useValue: keyIndex }] })
  class TieredSurfaceModule {}

  beforeAll(async () => {
    // 1mb cap: a 4mb budget whose anonymous pool is 2mb, 1mb per client address.
    process.env.BODY_SIZE_LIMIT = '1mb';
    app = await NestFactory.create<INestApplication<App>>(TieredSurfaceModule, { bodyParser: false, logger: false });
    configureApp(app);
    applyGlobalValidation(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (previousBodyLimit === undefined) delete process.env.BODY_SIZE_LIMIT;
    else process.env.BODY_SIZE_LIMIT = previousBodyLimit;
  });

  it('keeps room for a recognised key while an unrecognised client holds its whole share', async () => {
    const { port } = new URL(await app.getUrl());
    // Declares a full-size body, this address's whole share, and never finishes sending it.
    const held = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/echo',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024) },
    });
    held.on('error', () => undefined);
    held.write('{"a":"');
    await new Promise(resolve => setTimeout(resolve, 200));

    try {
      const anonymous = await request(app.getHttpServer())
        .post('/api/echo')
        .set('Content-Type', 'application/json')
        .send({ small: true });
      expect(anonymous.status).toBe(503);
      expect(anonymous.headers['retry-after']).toBeDefined();

      const keyed = await request(app.getHttpServer())
        .post('/api/echo')
        .set('Content-Type', 'application/json')
        .set('X-API-Key', 'known-key')
        .send({ small: true });
      expect(keyed.status).toBe(201);
    } finally {
      held.destroy();
    }
  });
});

describe('requests during shutdown teardown (configureApp)', () => {
  // Nest keeps the listener open until every destroy hook has finished, so the hook below can still
  // reach the server: it records what a client arriving mid-teardown gets back.
  let base = '';
  const handled: string[] = [];
  const duringTeardown: Record<string, request.Response> = {};
  let slowEntered!: () => void;
  const slowAdmitted = new Promise<void>(resolve => (slowEntered = resolve));
  let releaseSlow!: () => void;
  const slowReleased = new Promise<void>(resolve => (releaseSlow = resolve));

  @Controller()
  class TeardownProbeController {
    @Get('work')
    work() {
      handled.push('work');
      return { ok: true };
    }

    @Get('slow')
    async slow() {
      handled.push('slow');
      slowEntered();
      await slowReleased;
      return { ok: true };
    }

    @Get('health/live')
    live() {
      return { status: 'ok' };
    }
  }

  @Injectable()
  class TeardownProbe implements OnModuleDestroy {
    async onModuleDestroy() {
      for (const path of ['/api/work', '/api/health/live']) {
        duringTeardown[path] = await request(base).get(path).set('Connection', 'keep-alive');
      }
      releaseSlow();
    }
  }

  @Module({ controllers: [TeardownProbeController], providers: [ShutdownService, TeardownProbe] })
  class TeardownSurfaceModule {}

  it('refuses new requests once teardown begins, while admitted requests and the health probes complete', async () => {
    const app = await NestFactory.create<INestApplication<App>>(TeardownSurfaceModule, {
      bodyParser: false,
      logger: false,
    });
    configureApp(app);
    applyGlobalValidation(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();

    let exited!: () => void;
    const exitCalled = new Promise<void>(resolve => (exited = resolve));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => exited()) as never);
    let teardownStarted = false;
    try {
      const shutdown = app.get(ShutdownService);
      shutdown.setShutdownCallback(() => app.close());

      // The drain: readiness reports 503 so the balancer stops routing, but traffic is still served.
      shutdown.markShuttingDown();
      expect((await request(base).get('/api/work')).status).toBe(200);

      const slow = request(base)
        .get('/api/slow')
        .then(res => res);
      await slowAdmitted;
      teardownStarted = true;
      shutdown.shutdown(0);
      await exitCalled;

      const refused = duringTeardown['/api/work'];
      expect(refused.status).toBe(503);
      expect(refused.headers.connection).toBe('close');
      expect(refused.body).toEqual({
        statusCode: 503,
        message: 'Server is shutting down',
        error: 'Service Unavailable',
      });
      // The handler never ran for the refused request: only the drain-time call and the slow one did.
      expect(handled).toEqual(['work', 'slow']);
      expect(duringTeardown['/api/health/live'].status).toBe(200);
      expect((await slow).status).toBe(200);
    } finally {
      exitSpy.mockRestore();
      // A failure before teardown would otherwise leave the listener and the slow handler open.
      if (!teardownStarted) {
        releaseSlow();
        await app.close();
      }
    }
  });
});
