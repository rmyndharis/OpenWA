// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));
// Stub the heavy Baileys lib: the boot gate only verifies registration/enable, never a socket connect.
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  fetchLatestBaileysVersion: jest.fn(),
  getContentType: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { EngineFactory } from './../src/engine/engine.factory';

/**
 * Boots the real app module graph with ENGINE_TYPE=baileys. This is the integration gate: it proves
 * the second registration block + config wiring boot cleanly (the DI module-load cycle only surfaces
 * at full boot) without the Baileys socket ever connecting (AUTO_START_SESSIONS=false; lib mocked).
 */
describe('Baileys engine boot (e2e)', () => {
  let app: INestApplication<App>;
  let factory: EngineFactory;
  const prevEngine = process.env.ENGINE_TYPE;

  beforeAll(async () => {
    process.env.ENGINE_TYPE = 'baileys';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    factory = moduleFixture.get(EngineFactory);
  });

  afterAll(async () => {
    process.env.ENGINE_TYPE = prevEngine;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('selects baileys as the current engine', () => {
    expect(factory.getCurrentEngine()).toBe('baileys');
  });

  it('registers and enables the baileys engine plugin', () => {
    const engines = factory.getAvailableEngines();
    const baileys = engines.find(e => e.id === 'baileys');
    expect(baileys).toBeDefined();
    expect(baileys?.enabled).toBe(true);
    expect(baileys?.features).toEqual([
      'text-messages',
      'typing-indicator',
      'media-messages',
      'location-messages',
      'contact-messages',
      'message-replies',
      'message-forwarding',
      'message-reactions',
      'message-deletion',
      'group-management',
      'read-receipts',
    ]);
  });
});
