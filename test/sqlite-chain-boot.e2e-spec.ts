// Boots the production SQLite schema path from scratch: BOTH connections run their full migration
// chains (migrationsRun) against empty temp files, exactly as a fresh bare-metal/container deploy
// would, then asserts the app reaches readiness and the chain-built schema answers real queries.
// The rest of the e2e lane boots with synchronize=true (setup-e2e.ts), so this path - the one
// production takes on a default deploy - was never exercised end to end.
process.env.NODE_ENV = 'test';
process.env.DATABASE_TYPE = 'sqlite';
process.env.QUEUE_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
process.env.RATE_LIMIT_SHORT_LIMIT = '100000';
process.env.RATE_LIMIT_MEDIUM_LIMIT = '100000';
process.env.RATE_LIMIT_LONG_LIMIT = '100000';
process.env.DATABASE_SYNCHRONIZE = 'false';
// The main connection already runs its chain when the env is absent; 'false' is set explicitly so a
// value leaking in from the shell cannot boot main through synchronize. BOTH chains must run.
process.env.MAIN_DATABASE_SYNCHRONIZE = 'false';
// Fresh throwaway files per run; the chain must CREATE everything that exists in them.
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const dataDb = join(tmpdir(), `openwa-chain-${process.pid}.sqlite`);
const mainDb = join(tmpdir(), `openwa-chain-main-${process.pid}.sqlite`);
const keyFile = join(tmpdir(), `openwa-chain-key-${process.pid}`);
for (const f of [dataDb, mainDb, keyFile]) rmSync(f, { force: true });
process.env.DATABASE_NAME = dataDb;
process.env.MAIN_DATABASE_NAME = mainDb;
process.env.BOOTSTRAP_KEY_FILE = keyFile;

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';

describe('production SQLite schema path: full migration chain from scratch (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    applyGlobalValidation(app as never);
    await app.init();
  });

  afterAll(async () => {
    try {
      await app.close();
    } finally {
      for (const f of [dataDb, mainDb, keyFile]) rmSync(f, { force: true });
    }
  });

  it('boots to readiness against chain-built schema (both connections, no synchronize)', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect((res.body as { status: string }).status).toBe('ok');
  });

  it('the chain-built main schema answers auth queries (first-boot key written and usable)', async () => {
    // The bootstrap key file is written on first boot; reading it back proves the main connection's
    // migrations created api_keys and the boot path could persist.
    expect(existsSync(keyFile)).toBe(true);
    const key = readFileSync(keyFile, 'utf8').trim();
    expect(key).toMatch(/^owa_k1_/);
    const auth = await request(app.getHttpServer()).get('/api/sessions').set('X-API-Key', key).expect(200);
    expect(Array.isArray(auth.body)).toBe(true);
  });

  it('the chain-built data schema accepts writes (a session row round-trips)', async () => {
    const key = readFileSync(keyFile, 'utf8').trim();
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .set('X-API-Key', key)
      .send({ name: 'chain-boot-probe' })
      .expect(201);
    expect((created.body as { name: string }).name).toBe('chain-boot-probe');
    const list = await request(app.getHttpServer()).get('/api/sessions').set('X-API-Key', key).expect(200);
    expect(((list.body as Array<{ name: string }>) ?? []).some(s => s.name === 'chain-boot-probe')).toBe(true);
  });
});
