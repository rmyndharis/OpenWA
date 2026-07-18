import { Module, INestApplication, Controller, Get } from '@nestjs/common';
import { applyGlobalValidation } from '../src/config/app-validation';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Throwaway dashboard build, evaluated before the module decorator (forRoot reads rootPath eagerly).
const distDir = mkdtempSync(join(tmpdir(), 'openwa-dash-'));
writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>OpenWA Dashboard</title>');
mkdirSync(join(distDir, 'assets'));
writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log(1)');

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: distDir,
      exclude: ['/api/{*splat}', '/socket.io/{*splat}'],
    }),
  ],
  controllers: [PingController],
})
class ServeStaticTestModule {}

/**
 * Regression lock for single-port dashboard serving (app.module.ts). Bootstraps the SAME
 * serve-static config (rootPath + exclude) via NestFactory against a throwaway build dir:
 * the SPA must be served at `/` with client-side fallback, while Nest keeps ownership of
 * `/api` so unknown API routes return JSON 404s (not the SPA index.html). Pins the Express 5
 * / path-to-regexp v8 wildcard syntax (`/api/{*splat}`) - if a dep bump breaks it, /api/*
 * would start returning index.html and these tests fail.
 */
describe('Dashboard serve-static (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await NestFactory.create(ServeStaticTestModule, { logger: false });
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

  it('serves built assets', async () => {
    const res = await request(app.getHttpServer()).get('/assets/app.js');
    expect(res.status).toBe(200);
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
});
