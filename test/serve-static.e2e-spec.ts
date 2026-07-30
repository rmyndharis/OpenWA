import { Module, INestApplication, Controller, Get } from '@nestjs/common';
import { applyGlobalValidation } from '../src/config/app-validation';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep, extname } from 'path';
import type { Request, Response, NextFunction } from 'express';

/**
 * Two throwaway dashboard builds, evaluated before the module decorators (forRoot reads rootPath
 * eagerly). The second deliberately sits under a DOT-SEGMENT directory, which is not exotic:
 * `~/.openwa`, a CI checkout under `~/.cache`, and a `TMPDIR` inside a dotdir all produce it.
 * `ServeStaticModule`'s own SPA fallback silently 404s every client-side route on such a path
 * (it sends the index by absolute path, and Express's `send` refuses dot-segments), so the shape
 * has to be covered explicitly or a real deployment class goes untested.
 */
function makeBuild(root: string): string {
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>OpenWA Dashboard</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, '.env.secret'), 'TOKEN=nope');
  return root;
}

const hasDotSegment = (p: string): boolean => p.split(sep).some(segment => segment.startsWith('.'));

const osTmp = realpathSync(tmpdir());
// The "plain" build must sit under a genuinely dot-free prefix. os.tmpdir() is NOT reliably
// dot-free, and using it blindly would make BOTH cases dotted - which is exactly how this gap
// stayed hidden. node_modules is gitignored, so nothing strays into the working tree.
const dotFreeBase = hasDotSegment(osTmp) ? join(__dirname, '..', 'node_modules') : osTmp;
const plainDist = makeBuild(join(mkdtempSync(join(dotFreeBase, 'openwa-dash-plain-')), 'dashboard', 'dist'));
const dottedDist = makeBuild(join(mkdtempSync(join(osTmp, 'openwa-dash-')), '.dotted', 'dashboard', 'dist'));

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

const EXCLUDE = ['/api/{*splat}', '/socket.io/{*splat}'];
// Mirrors app.module.ts: the module's own catch-all fallback is off, main.ts's document
// handler owns SPA routes. Without this the module answers every unmatched GET with the
// shell, which is the behaviour the missing-asset test below exists to prevent.
const RENDER_DISABLED = '/__openwa_spa_fallback_owned_by_main_ts__';

@Module({
  imports: [ServeStaticModule.forRoot({ rootPath: plainDist, exclude: EXCLUDE, renderPath: RENDER_DISABLED })],
  controllers: [PingController],
})
class PlainServeStaticModule {}

@Module({
  imports: [ServeStaticModule.forRoot({ rootPath: dottedDist, exclude: EXCLUDE, renderPath: RENDER_DISABLED })],
  controllers: [PingController],
})
class DottedServeStaticModule {}

/**
 * Mirrors the SPA document handler main.ts installs (the CSP-nonce one), minus the nonce
 * injection. It is load-bearing, not decoration: it reads the index with `readFileSync` and
 * `res.send`s it, which is what makes client-side routes work at all on a dot-segment install
 * path. Reproducing serve-static WITHOUT it - as this spec used to - tests a stack that does
 * not exist in production and reports a failure the product does not have.
 */
function applyDashboardDocumentHandler(app: INestApplication<App>, distDir: string): void {
  const dashboardIndex = readFileSync(join(distDir, 'index.html'), 'utf8');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const excluded =
      req.path.startsWith('/api/') ||
      req.path === '/api' ||
      req.path.startsWith('/socket.io/') ||
      req.path === '/socket.io' ||
      req.path.startsWith('/mcp/') ||
      req.path === '/mcp' ||
      req.path.startsWith('/assets/');
    const documentRequest =
      req.method === 'GET' &&
      !excluded &&
      ((req.headers.accept ?? '').includes('text/html') || extname(req.path) === '');
    if (!documentRequest) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(dashboardIndex);
  });
}

describe('serve-static test fixtures', () => {
  it('really does cover BOTH install-path shapes', () => {
    // Without this, a dotted os.tmpdir() collapses the matrix onto one shape and the
    // dot-segment case silently stops being tested.
    expect(hasDotSegment(plainDist)).toBe(false);
    expect(hasDotSegment(dottedDist)).toBe(true);
  });
});

/**
 * Regression lock for single-port dashboard serving (app.module.ts + main.ts). Bootstraps the SAME
 * serve-static config (rootPath + exclude) AND the same document handler against a throwaway build:
 * the SPA must be served at `/` with client-side fallback, while Nest keeps ownership of `/api` so
 * unknown API routes return JSON 404s (not the SPA index.html). Pins the Express 5 /
 * path-to-regexp v8 wildcard syntax (`/api/{*splat}`) - if a dep bump breaks it, /api/* would start
 * returning index.html and these tests fail.
 */
describe.each([
  ['a plain install path', PlainServeStaticModule, plainDist],
  ['an install path with a dot-segment', DottedServeStaticModule, dottedDist],
])('Dashboard serve-static (e2e) - %s', (_label, moduleClass, distDir) => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await NestFactory.create(moduleClass, { logger: false });
    applyDashboardDocumentHandler(app, distDir);
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the dashboard index.html at /', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('OpenWA Dashboard');
  });

  it('serves index.html for client-side routes (SPA fallback)', async () => {
    const res = await request(app.getHttpServer()).get('/sessions');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('serves index.html for a nested client-side route', async () => {
    const res = await request(app.getHttpServer()).get('/sessions/abc/messages');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('serves built assets with their own content-type (not the SPA shell)', async () => {
    const res = await request(app.getHttpServer()).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).not.toContain('OpenWA Dashboard');
  });

  it('404s a missing asset instead of handing back the SPA shell', async () => {
    // A mistyped <script src> must fail loudly. Answering 200 HTML makes the browser try to
    // parse the shell as JavaScript and report a syntax error, hiding the real cause.
    const res = await request(app.getHttpServer()).get('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('OpenWA Dashboard');
  });

  it('404s a missing top-level file rather than serving the shell', async () => {
    const res = await request(app.getHttpServer()).get('/favicon-missing.svg');
    expect(res.status).toBe(404);
  });

  it('never serves a dotfile out of the build directory', async () => {
    const res = await request(app.getHttpServer()).get('/.env.secret');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('TOKEN=');
  });

  it('lets Nest handle /api routes (real controller, not the SPA)', async () => {
    const res = await request(app.getHttpServer()).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns a JSON 404 (not the SPA) for unknown /api routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.text).not.toContain('OpenWA Dashboard');
  });

  it('does not hand the SPA to a non-GET request', async () => {
    // A mistyped POST must fail loudly rather than receiving a 200 HTML shell.
    const res = await request(app.getHttpServer()).post('/sessions');
    expect(res.status).not.toBe(200);
  });
});
