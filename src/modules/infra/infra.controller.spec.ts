import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';

// StorageService (imported transitively by InfraController) pulls in `archiver`
// v8, which is ESM-only and cannot be parsed by ts-jest. The controller logic
// under test never touches archiver, so a lightweight stub is sufficient.
jest.mock('archiver', () => ({ default: jest.fn() }));

// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
  };
});

import { DataSource, QueryFailedError } from 'typeorm';
import { InfraController } from './infra.controller';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch, BatchStatus } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';

describe('InfraController access control (Vuln 2)', () => {
  const reflector = new Reflector();

  // Every mutating, data-exfiltration, and operational-read endpoint must require
  // the ADMIN role so that a low-privilege (VIEWER/OPERATOR) API key cannot wipe
  // data, read secrets, change config, restart, trigger storage import, or read
  // infrastructure status / engine / storage details (#221 tightened the reads).
  const adminOnly = [
    'getConfig', // GET  /infra/config (returns saved config; secrets omitted but still ADMIN-only)
    'saveConfig', // PUT  /infra/config
    'requestRestart', // POST /infra/restart
    'exportData', // GET  /infra/export-data  (exposes webhook secrets)
    'importData', // POST /infra/import-data  (DELETEs all rows)
    'exportStorage', // GET  /infra/storage/export
    'importStorage', // POST /infra/storage/import
    'getStatus', // GET  /infra/status
    'getEngines', // GET  /infra/engines
    'getCurrentEngine', // GET  /infra/engines/current
    'getStorageFileCount', // GET  /infra/storage/files/count
  ] as const;

  it.each(adminOnly)('%s requires the ADMIN role', method => {
    // The handler is only ever a lookup key for reflector metadata — it is never invoked, so there is
    // no `this` to lose. unbound-method (tightened in typescript-eslint 8.65) cannot tell the two
    // apart, and the cast below does not satisfy it either.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = InfraController.prototype[method as keyof InfraController] as unknown as (
      ...args: unknown[]
    ) => unknown;
    const role = reflector.get<ApiKeyRole | undefined>(REQUIRED_ROLE_KEY, handler);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });
});

describe('InfraController.importStorage filePath validation (Vuln 3)', () => {
  function buildController(storage: Partial<{ importFromStream: jest.Mock; getCurrentStorageType: jest.Mock }>) {
    return new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      storage as never,
      {} as never,
    );
  }

  it('rejects a filePath that escapes the data directory before touching the filesystem', async () => {
    const storage = { importFromStream: jest.fn(), getCurrentStorageType: jest.fn(() => 'local') };
    const controller = buildController(storage);

    await expect(controller.importStorage({ filePath: '../../../../etc/passwd' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.importFromStream).not.toHaveBeenCalled();
  });

  it('guards and opens the same cwd-resolved path returned by storage export', async () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/export.tar.gz');
    (fs.createReadStream as jest.Mock).mockClear();
    const storage = {
      importFromStream: jest.fn().mockResolvedValue(3),
      getCurrentStorageType: jest.fn(() => 'local'),
    };
    try {
      const result = await buildController(storage).importStorage({ filePath: 'data/exports/export.tar.gz' });
      expect(fs.createReadStream).toHaveBeenCalledWith('/srv/openwa/data/exports/export.tar.gz');
      expect(storage.importFromStream).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ imported: true, count: 3, storageType: 'local' });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });
});

describe('InfraController.getStatus DB health (active SELECT 1 probe, not just isInitialized)', () => {
  const build = (query: jest.Mock) => {
    // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
    const config = { get: (k: string, def?: unknown) => (k === 'engine.type' ? 'baileys' : def) };
    const ds = { isInitialized: true, query };
    const cache = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
    return new InfraController(
      config as never,
      ds as never,
      ds as never,
      { create: jest.fn() } as never,
      { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() } as never,
      cache as never,
      { refreshS3Availability: jest.fn() } as never,
      {} as never,
      undefined as never,
    );
  };

  it('reports connected:true when SELECT 1 succeeds', async () => {
    const status = await build(jest.fn().mockResolvedValue([{ '1': 1 }])).getStatus();
    expect(status.database.connected).toBe(true);
  });

  it('reports connected:false when the DB is initialized but SELECT 1 fails (backend died post-init)', async () => {
    const status = await build(jest.fn().mockRejectedValue(new Error('ECONNRESET'))).getStatus();
    expect(status.database.connected).toBe(false);
  });
});

describe('InfraController.getStatus queue job counts', () => {
  function buildStatusController(opts: { queueEnabled: boolean; queue?: { getJobCounts: jest.Mock } }) {
    const configService = {
      get: (key: string, def?: unknown) => (key === 'queue.enabled' ? opts.queueEnabled : def),
    };
    const dataSource = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) } as unknown;
    const engineFactory = { create: jest.fn() };
    const dockerService = { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() };
    const cacheService = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
    const storageService = { refreshS3Availability: jest.fn() };
    const shutdownService = {};
    return new InfraController(
      configService as never,
      dataSource as never,
      dataSource as never,
      engineFactory as never,
      dockerService as never,
      cacheService as never,
      storageService as never,
      shutdownService as never,
      opts.queue as never,
    );
  }

  it('reports live webhook job counts when the queue is enabled (pending = wait+active+delayed)', async () => {
    const getJobCounts = jest.fn().mockResolvedValue({ wait: 2, active: 1, delayed: 3, completed: 10, failed: 1 });
    const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts } });

    const status = await controller.getStatus();

    expect(getJobCounts).toHaveBeenCalledWith('wait', 'active', 'delayed', 'completed', 'failed');
    expect(status.queue).toEqual({ enabled: true, webhooks: { pending: 6, completed: 10, failed: 1 } });
  });

  it('reports zeros (and does not touch the queue) when the queue is disabled', async () => {
    const getJobCounts = jest.fn();
    const controller = buildStatusController({ queueEnabled: false, queue: { getJobCounts } });

    const status = await controller.getStatus();

    expect(getJobCounts).not.toHaveBeenCalled();
    expect(status.queue).toEqual({ enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } });
  });
});

describe('InfraController.saveConfig SSL reject-unauthorized', () => {
  function writtenEnv(config: unknown): string {
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const controller = new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    controller.saveConfig(config as never);
    const content = spy.mock.calls[0][1] as string;
    spy.mockRestore();
    return content;
  }

  it('writes DATABASE_SSL_REJECT_UNAUTHORIZED=false for self-signed managed Postgres', () => {
    const env = writtenEnv({ database: { type: 'postgres', sslEnabled: true, sslRejectUnauthorized: false } });
    expect(env).toContain('DATABASE_SSL=true');
    expect(env).toContain('DATABASE_SSL_REJECT_UNAUTHORIZED=false');
  });

  it('defaults DATABASE_SSL_REJECT_UNAUTHORIZED=true when SSL is enabled without an explicit flag', () => {
    const env = writtenEnv({ database: { type: 'postgres', sslEnabled: true } });
    expect(env).toContain('DATABASE_SSL_REJECT_UNAUTHORIZED=true');
  });

  it('omits DATABASE_SSL_REJECT_UNAUTHORIZED when SSL is disabled', () => {
    const env = writtenEnv({ database: { type: 'postgres', sslEnabled: false } });
    expect(env).not.toContain('DATABASE_SSL_REJECT_UNAUTHORIZED');
  });
});

describe('InfraController PostgreSQL schema (POSTGRES_SCHEMA)', () => {
  const newController = () =>
    new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(config as never);
    const content = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
    return content;
  }

  it('writes POSTGRES_SCHEMA for external Postgres', () => {
    const env = written({ database: { type: 'postgres', builtIn: false, host: 'db', schema: 'openwa' } });
    expect(env).toContain('POSTGRES_SCHEMA=openwa');
  });

  it('defaults POSTGRES_SCHEMA to public for external Postgres when no schema is provided', () => {
    const env = written({ database: { type: 'postgres', builtIn: false, host: 'db' } });
    expect(env).toContain('POSTGRES_SCHEMA=public');
  });

  it('pins POSTGRES_SCHEMA=public for the built-in Postgres container', () => {
    const env = written({ database: { type: 'postgres', builtIn: true } });
    expect(env).toContain('POSTGRES_SCHEMA=public');
  });

  it('does not write POSTGRES_SCHEMA for sqlite', () => {
    const env = written({ database: { type: 'sqlite' } });
    expect(env).not.toContain('POSTGRES_SCHEMA=');
  });

  it('getConfig surfaces the saved POSTGRES_SCHEMA, defaulting to public', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('DATABASE_TYPE=postgres\nPOSTGRES_SCHEMA=openwa\n');
    expect(newController().getConfig().database.schema).toBe('openwa');
    (fs.readFileSync as jest.Mock).mockReturnValue('DATABASE_TYPE=postgres\n');
    expect(newController().getConfig().database.schema).toBe('public');
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });
});

describe('InfraController.saveConfig writes the generated env owner-only', () => {
  // data/.env.generated holds DB/S3/Redis credentials, so it must be written 0600 — not the
  // default 0644 (world-readable). The write must go through the same owner-only path the
  // first-run boot uses, closing the gap between a dashboard save and the next restart.
  it('persists data/.env.generated with mode 0600, not world-readable', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const controller = new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    controller.saveConfig({ database: { type: 'postgres', sslEnabled: true, password: 'pw' } } as never);
    const opts = writeSpy.mock.calls[0][2];
    expect(opts).toEqual({ mode: 0o600 });
    writeSpy.mockRestore();
  });
});

describe('InfraController.saveConfig env-name correctness and merge (#226)', () => {
  const newController = () =>
    new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(config as never);
    const calls = (fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>;
    const content = calls[0][1];
    // Reset to defaults so later tests start from "no prior config".
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
    return content;
  }

  it('writes the env names the backend actually reads (not the old ignored names)', () => {
    const env = written({
      engine: { headless: false, sessionDataPath: './sess', browserArgs: '--flag' },
      storage: { type: 's3', s3Bucket: 'b', s3AccessKey: 'ak', s3SecretKey: 'sk' },
    });
    // Correct names (configuration.ts reads these)
    expect(env).toContain('PUPPETEER_HEADLESS=false');
    expect(env).toContain('SESSION_DATA_PATH=./sess');
    expect(env).toContain('PUPPETEER_ARGS=--flag');
    expect(env).toContain('S3_ACCESS_KEY_ID=ak');
    expect(env).toContain('S3_SECRET_ACCESS_KEY=sk');
    // Old, silently-ignored names must be gone
    expect(env).not.toContain('ENGINE_HEADLESS=');
    expect(env).not.toContain('ENGINE_SESSION_PATH=');
    expect(env).not.toContain('ENGINE_BROWSER_ARGS=');
    expect(env).not.toContain('S3_ACCESS_KEY=');
    expect(env).not.toContain('S3_SECRET_KEY=');
  });

  it('defaults PUPPETEER_ARGS to the full Docker sandbox flag set when browserArgs is empty', () => {
    // Once compose blank-forwards PUPPETEER_ARGS this saved value wins at runtime, so the default must
    // keep --disable-dev-shm-usage (the Docker /dev/shm tab-crash guard) — NOT the old 2-flag set.
    const env = written({ engine: { headless: true, sessionDataPath: './data/sessions', browserArgs: '' } });
    expect(env).toContain('PUPPETEER_ARGS=--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu');
    expect(env).not.toContain('PUPPETEER_ARGS=--no-sandbox --disable-gpu');
  });

  it('writes STORAGE_LOCAL_PATH (the name the backend reads) for local storage', () => {
    const env = written({ storage: { type: 'local', localPath: './data/media' } });
    expect(env).toContain('STORAGE_LOCAL_PATH=./data/media');
    expect(env).not.toContain('STORAGE_PATH=');
  });

  it('preserves existing keys that are not in the current payload', () => {
    const env = written({ engine: { headless: true } }, 'WEBHOOK_TIMEOUT=5000\nSESSION_DATA_PATH=./old\n');
    expect(env).toContain('WEBHOOK_TIMEOUT=5000'); // untouched key survives
    expect(env).toContain('PUPPETEER_HEADLESS=true'); // payload applied
  });

  it('does not blank a stored secret when the form submits an empty value', () => {
    const env = written({ database: { type: 'postgres', host: 'db', password: '' } }, 'DATABASE_PASSWORD=keepme\n');
    expect(env).toContain('DATABASE_PASSWORD=keepme');
    expect(env).toContain('DATABASE_HOST=db');
  });

  it('drops stale postgres keys (including POSTGRES_SCHEMA) when switching to sqlite', () => {
    const existing =
      'DATABASE_TYPE=postgres\nDATABASE_HOST=oldhost\nDATABASE_PASSWORD=secret\nDATABASE_PORT=5432\nPOSTGRES_SCHEMA=openwa\n';
    const env = written({ database: { type: 'sqlite' } }, existing);
    expect(env).toContain('DATABASE_TYPE=sqlite');
    expect(env).not.toContain('DATABASE_HOST=');
    expect(env).not.toContain('DATABASE_PASSWORD=');
    expect(env).not.toContain('DATABASE_PORT=');
    expect(env).not.toContain('POSTGRES_SCHEMA=');
  });

  it('drops stale S3 keys when switching storage to local', () => {
    const existing =
      'STORAGE_TYPE=s3\nS3_BUCKET=old\nS3_ACCESS_KEY_ID=ak\nS3_SECRET_ACCESS_KEY=sk\nS3_ENDPOINT=http://x\n';
    const env = written({ storage: { type: 'local', localPath: './data/media' } }, existing);
    expect(env).toContain('STORAGE_TYPE=local');
    expect(env).toContain('STORAGE_LOCAL_PATH=./data/media');
    expect(env).not.toContain('S3_BUCKET=');
    expect(env).not.toContain('S3_ACCESS_KEY_ID=');
    expect(env).not.toContain('S3_SECRET_ACCESS_KEY=');
  });
});

describe('InfraController.saveConfig rejects values that would inject extra env vars', () => {
  const newController = () =>
    new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  // .env.generated is one KEY=value per line and is loaded on the next boot. A value carrying a
  // newline would write a second `KEY=value` line — injecting an arbitrary env var (e.g. an admin
  // key) the operator never set. Such a value must be refused outright, with nothing written.
  it.each([
    ['linefeed', '--no-sandbox\nADMIN_MASTER_KEY=attacker'],
    ['carriage return', '--no-sandbox\rADMIN_MASTER_KEY=attacker'],
  ])('does not persist a config value containing a %s', (_label, malicious) => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();

    // A newline-injected value is rejected outright with a 4xx (BadRequestException), not masked as a
    // {saved:false} 200 — and nothing is written.
    expect(() => newController().saveConfig({ engine: { browserArgs: malicious } })).toThrow(BadRequestException);
    expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
  });

  it('still persists a normal value with the same key', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();

    const result = newController().saveConfig({ engine: { browserArgs: '--no-sandbox --disable-gpu' } });

    expect(result.saved).toBe(true);
    expect(fs.writeFileSync as jest.Mock).toHaveBeenCalled();
  });
});

describe('InfraController.saveConfig engine selection (persist ENGINE_TYPE — Infrastructure tile)', () => {
  const engineFactory = {
    getAvailableEngines: () => [{ id: 'whatsapp-web.js' }, { id: 'baileys' }],
  };
  const newController = () =>
    new InfraController(
      {} as never,
      {} as never,
      {} as never,
      engineFactory as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(config as never);
    const content = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
    return content;
  }

  it('persists ENGINE_TYPE when a valid engine is selected', () => {
    const env = written({ engine: { type: 'baileys', headless: true } });
    expect(env).toContain('ENGINE_TYPE=baileys');
  });

  it('does not write ENGINE_TYPE when no engine type is provided (avoids clobbering)', () => {
    const env = written({ engine: { headless: false } });
    expect(env).not.toContain('ENGINE_TYPE=');
    expect(env).toContain('PUPPETEER_HEADLESS=false');
  });

  it('rejects an unknown engine type and writes nothing', () => {
    (fs.writeFileSync as jest.Mock).mockClear();
    // Rejected as a 4xx (BadRequestException naming the bad engine), not a {saved:false} 200.
    expect(() => newController().saveConfig({ engine: { type: 'bogus' } })).toThrow(/unknown engine/i);
    expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('InfraController.importData round-trips export-data (no silent message/batch loss)', () => {
  let ds: DataSource;
  let controller: InfraController;
  // exportData only reads dataDatabase.type off the config; everything else is unused here.
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };

  const newController = () =>
    new InfraController(cfg as never, {} as never, ds, {} as never, {} as never, {} as never, {} as never, {} as never);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
      ],
      synchronize: true,
    });
    await ds.initialize();
    controller = newController();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const seedSession = (id: string) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  it('restores messages and message_batches faithfully — not silently to zero', async () => {
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        waMessageId: 'WA1',
        chatId: 'c1@s.whatsapp.net',
        chatName: 'Support Chat',
        from: 'a@s.whatsapp.net',
        to: 'b@s.whatsapp.net',
        body: 'hello',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1700000000,
        metadata: { ack: 2 },
        status: MessageStatus.DELIVERED,
      }),
    );
    await ds.getRepository(MessageBatch).save(
      ds.getRepository(MessageBatch).create({
        id: 'b1',
        batchId: 'BATCH1',
        sessionId: 's1',
        status: BatchStatus.COMPLETED,
        messages: [{ chatId: 'c1', type: 'text', content: {} }],
        options: null as never,
        progress: null as never,
        results: null as never,
        currentIndex: 0,
        startedAt: null,
        completedAt: null,
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.messages).toBe(1);
    expect(dump.counts.messageBatches).toBe(1);

    const res = await controller.importData({ tables: dump.tables });

    // The whole point of the bug: a valid backup must restore with no warnings and imported:true.
    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.messages).toBe(1);
    expect(res.counts.messageBatches).toBe(1);

    // ...and the rows must actually be present after the DELETE+reinsert, with fields intact.
    expect(await ds.getRepository(Message).count()).toBe(1);
    expect(await ds.getRepository(MessageBatch).count()).toBe(1);
    const m = await ds.getRepository(Message).findOneByOrFail({ id: 'm1' });
    expect(m.body).toBe('hello');
    expect(m.waMessageId).toBe('WA1');
    expect(m.chatName).toBe('Support Chat');
    expect(m.from).toBe('a@s.whatsapp.net');
    expect(m.to).toBe('b@s.whatsapp.net');
    expect(m.metadata).toEqual({ ack: 2 });
    const b = await ds.getRepository(MessageBatch).findOneByOrFail({ id: 'b1' });
    expect(b.batchId).toBe('BATCH1');
    expect(b.status).toBe(BatchStatus.COMPLETED);
  });

  it('round-trips plugin instances + integration delivery failures (Integration Fabric + DLQ)', async () => {
    await seedSession('s1');
    await ds.getRepository(PluginInstance).save(
      ds.getRepository(PluginInstance).create({
        id: 'chatwoot:acct1',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        sessionScope: 's1',
        secret: 'hmac-secret',
        verifyToken: null,
        config: { baseUrl: 'https://x' },
        enabled: true,
      }),
    );
    await ds.getRepository(IntegrationDeliveryFailure).save(
      ds.getRepository(IntegrationDeliveryFailure).create({
        direction: 'outbound',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        sessionId: 's1',
        deliveryId: 'd1',
        attempts: 3,
        lastError: 'boom',
        payload: { foo: 'bar' },
        redriven: false,
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.pluginInstances).toBe(1);
    expect(dump.counts.integrationDeliveryFailures).toBe(1);

    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.pluginInstances).toBe(1);
    expect(res.counts.integrationDeliveryFailures).toBe(1);

    expect(await ds.getRepository(PluginInstance).count()).toBe(1);
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(1);
    const pi = await ds.getRepository(PluginInstance).findOneByOrFail({ id: 'chatwoot:acct1' });
    expect(pi.secret).toBe('hmac-secret'); // ingress HMAC secret survives a SQLite→Postgres migration
    expect(pi.config).toEqual({ baseUrl: 'https://x' });
    const dlf = await ds.getRepository(IntegrationDeliveryFailure).findOneByOrFail({ deliveryId: 'd1' });
    expect(dlf.lastError).toBe('boom');
    expect(dlf.payload).toEqual({ foo: 'bar' });
  });

  it('rolls back and reports imported:false when a row fails — existing data is preserved', async () => {
    // Pre-existing data that must survive a failed import.
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        waMessageId: 'WA1',
        chatId: 'c1',
        from: 'a',
        to: 'b',
        body: 'keep me',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      }),
    );

    // A backup whose message row is malformed (missing the non-null from/to) must fail the whole import.
    const res = await controller.importData({
      tables: {
        sessions: [{ id: 's2', name: 'imported', status: 'ready' }] as never,
        messages: [
          { id: 'mX', sessionId: 's2', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ] as never,
      },
    });

    expect(res.imported).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);

    // The destructive DELETE must have been rolled back — original data intact, nothing from the bad import.
    expect(await ds.getRepository(Message).count()).toBe(1);
    expect((await ds.getRepository(Message).findOneByOrFail({ id: 'm1' })).body).toBe('keep me');
    expect(await ds.getRepository(Session).findOneBy({ id: 's2' })).toBeNull();
  });

  it('refuses an empty/garbage backup — does not wipe existing data (#488 review must-fix)', async () => {
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        chatId: 'c1',
        from: 'a',
        to: 'b',
        body: 'keep me',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      }),
    );

    // A wrong/empty file (no rows to restore) must NOT commit the all-rows DELETE and report success.
    const res = await controller.importData({ tables: {} });

    expect(res.imported).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(await ds.getRepository(Session).count()).toBe(1);
    expect(await ds.getRepository(Message).count()).toBe(1);
  });

  it('propagates a genuine clear-table failure (lock/IO) instead of committing a merged restore', async () => {
    // Pre-existing data that must survive if a clear step fails.
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        chatId: 'c1',
        from: 'a',
        to: 'b',
        body: 'keep me',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      }),
    );

    expect(await ds.getRepository(Message).count()).toBe(1); // sanity: seeded

    // Make ONLY `DELETE FROM messages` fail with a genuine (non-missing-table) error. Previously a
    // blind `.catch(() => {})` swallowed this and let a disjoint-id backup COMMIT a merged (not
    // replaced) restore on SQLite; scoping the swallow to missing-table means the failure must now
    // SURFACE (reaching the existing rollback-and-rethrow catch). A Proxy over the runner the
    // controller creates intercepts just that one statement — no spy on `query`, so TypeORM's own
    // internal `this.query` transaction control (BEGIN/ROLLBACK) is untouched.
    const lockErr = new QueryFailedError(
      'DELETE FROM messages',
      [],
      Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }),
    );
    let rolledBack = false;
    const origCreate = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation(() => {
      const real = origCreate();
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'query') {
            return (sql: string, params?: unknown[]) =>
              sql === 'DELETE FROM messages'
                ? Promise.reject(lockErr)
                : (target.query as (q: string, p?: unknown[]) => Promise<unknown>).call(target, sql, params);
          }
          if (prop === 'rollbackTransaction') {
            return async () => {
              rolledBack = true;
              return target.rollbackTransaction.call(target);
            };
          }
          const val = (target as unknown as Record<string, unknown>)[prop as string];
          return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
        },
      });
    });

    await expect(controller.importData({ tables: { messages: [] } })).rejects.toThrow(/database is locked/);
    expect(rolledBack).toBe(true);

    jest.restoreAllMocks();
  });
});

describe('InfraController.import/export preserves every data-DB table', () => {
  let ds: DataSource;
  let controller: InfraController;
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  const newController = () =>
    new InfraController(cfg as never, {} as never, ds, {} as never, {} as never, {} as never, {} as never, {} as never);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Session, Webhook, Message, MessageBatch, Template, BaileysStoredMessage, LidMapping],
      synchronize: true,
    });
    await ds.initialize();
    controller = newController();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const seedSession = (id: string) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  // lid_mappings is the persisted lid->phone cache; it is NOT a FK to sessions, so the sessions DELETE
  // never touches it — but export omitted it, so a backup→restore into a fresh DB dropped it entirely.
  it('restores lid_mappings instead of dropping them on a backup→restore', async () => {
    await seedSession('s1');
    const lidRepo = ds.getRepository(LidMapping);
    await lidRepo.save(lidRepo.create({ lid: '111', phone: '628111', sessionId: 's1' }));
    await lidRepo.save(lidRepo.create({ lid: '222', phone: null, sessionId: 's1' })); // negative cache

    const dump = await controller.exportData();
    expect((dump.tables as unknown as { lidMappings?: unknown[] }).lidMappings).toHaveLength(2);

    // Simulate restoring into a fresh data DB (the documented backend-migration flow).
    await lidRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(await lidRepo.count()).toBe(2);
    expect((await lidRepo.findOneByOrFail({ lid: '111' })).phone).toBe('628111');
    expect((await lidRepo.findOneByOrFail({ lid: '222' })).phone).toBeNull();
  });

  // DELETE FROM sessions cascades to templates + baileys_stored_messages (both FK ON DELETE CASCADE),
  // so an import that never re-inserts them permanently wipes both on the documented backup flow.
  it('restores templates and baileys_stored_messages instead of cascade-wiping them', async () => {
    await seedSession('s1');
    await ds
      .getRepository(Template)
      .save(ds.getRepository(Template).create({ id: 't1', sessionId: 's1', name: 'greet', body: 'Hi {{name}}' }));
    await ds.getRepository(BaileysStoredMessage).save(
      ds.getRepository(BaileysStoredMessage).create({
        id: 'bsm1',
        sessionId: 's1',
        waMessageId: 'WA1',
        serializedMessage: '{"k":"v"}',
      }),
    );

    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(await ds.getRepository(Template).count()).toBe(1);
    expect(await ds.getRepository(BaileysStoredMessage).count()).toBe(1);
    expect((await ds.getRepository(Template).findOneByOrFail({ id: 't1' })).body).toBe('Hi {{name}}');
    expect((await ds.getRepository(BaileysStoredMessage).findOneByOrFail({ id: 'bsm1' })).serializedMessage).toBe(
      '{"k":"v"}',
    );
  });

  // The webhooks INSERT omitted the `filters` column, so a filtered webhook came back firing on
  // every event after a restore (over-delivery / PII fan-out).
  it('preserves webhook filters across a round-trip', async () => {
    await seedSession('s1');
    await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        id: 'w1',
        sessionId: 's1',
        url: 'https://example.com/hook',
        events: ['message'],
        secret: null,
        headers: {},
        active: true,
        retryCount: 3,
        filters: { conditions: [{ field: 'sender', operator: 'equals', value: '123@c.us' }] },
      }),
    );

    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.imported).toBe(true);
    expect((await ds.getRepository(Webhook).findOneByOrFail({ id: 'w1' })).filters).toEqual({
      conditions: [{ field: 'sender', operator: 'equals', value: '123@c.us' }],
    });
    // The active flag (exported as integer 1 from SQLite) must round-trip as a real boolean.
    expect((await ds.getRepository(Webhook).findOneByOrFail({ id: 'w1' })).active).toBe(true);
  });
});

describe('InfraController.getConfig (#226)', () => {
  it('returns the saved config shape without echoing secrets', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      'DATABASE_TYPE=postgres\nDATABASE_HOST=db\nDATABASE_PASSWORD=secret\nSESSION_DATA_PATH=./sess\nENGINE_TYPE=baileys\nSTORAGE_TYPE=s3\nS3_ACCESS_KEY_ID=ak\nS3_SECRET_ACCESS_KEY=sk\n',
    );
    const controller = new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const cfg = controller.getConfig();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');

    expect(cfg.database.type).toBe('postgres');
    expect(cfg.database.host).toBe('db');
    expect(cfg.database.passwordSet).toBe(true);
    expect(cfg.engine.sessionDataPath).toBe('./sess');
    expect(cfg.engine.type).toBe('baileys');
    expect(cfg.storage.type).toBe('s3');
    expect(cfg.storage.s3CredentialsSet).toBe(true);
    // Secrets are never present on the returned object.
    expect(JSON.stringify(cfg)).not.toContain('secret');
    expect(JSON.stringify(cfg)).not.toContain('"ak"');
  });
});

describe('InfraController.getStatus engine (reads the real engine.puppeteer.* keys)', () => {
  // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  it('reports the saved headless/browserArgs instead of stale defaults from non-existent flat keys', async () => {
    const map: Record<string, unknown> = {
      'engine.type': 'whatsapp-web.js',
      'engine.puppeteer.headless': false,
      'engine.puppeteer.args': ['--foo', '--bar'],
      'engine.sessionDataPath': './sess',
    };
    const config = { get: (key: string, def?: unknown) => (key in map ? map[key] : def) };
    const cache = { isAvailable: () => Promise.resolve(false) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const controller = new InfraController(
      config as never,
      ds as never,
      ds as never,
      {} as never, // engineFactory
      { isDockerAvailable: () => false } as never, // dockerService — no Docker in unit tests
      cache as never,
      { isS3Available: () => false, refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
      {} as never, // shutdownService
    );

    const status = await controller.getStatus();
    expect(status.engine.headless).toBe(false);
    expect(status.engine.browserArgs).toBe('--foo --bar');
    expect(status.engine.sessionDataPath).toBe('./sess');
  });
});

describe('InfraController.getStatus storage (reads the real storage.localPath key)', () => {
  // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
  const savedWebVer = process.env.WWEBJS_WEB_VERSION;
  beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
  afterAll(() => {
    if (savedWebVer === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVer;
  });

  const buildController = (map: Record<string, unknown>) => {
    const config = { get: (key: string, def?: unknown) => (key in map ? map[key] : def) };
    const cache = { isAvailable: () => Promise.resolve(false) };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    return new InfraController(
      config as never,
      ds as never,
      ds as never,
      {} as never, // engineFactory
      { isDockerAvailable: () => false } as never, // dockerService — no Docker in unit tests
      cache as never,
      { isS3Available: () => false, refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
      {} as never, // shutdownService
    );
  };

  it('reports the configured storage.localPath, not the ./uploads fallback', async () => {
    // The bug: status read the non-existent `storage.path` key, so it always reported the
    // `./uploads` fallback instead of the real path StorageService uses (`storage.localPath`).
    const status = await buildController({
      'storage.type': 'local',
      'storage.localPath': '/srv/openwa/media',
    }).getStatus();
    expect(status.storage.path).toBe('/srv/openwa/media');
  });

  it('falls back to ./data/media (matching StorageService) when storage.localPath is unset', async () => {
    const status = await buildController({ 'storage.type': 'local' }).getStatus();
    expect(status.storage.path).toBe('./data/media');
  });

  it('reports the bucket in S3 mode so the active backend is visible', async () => {
    const status = await buildController({ 'storage.type': 's3', 'storage.s3.bucket': 'my-openwa-bucket' }).getStatus();
    expect(status.storage.type).toBe('s3');
    expect(status.storage.bucket).toBe('my-openwa-bucket');
  });

  it('omits bucket in local mode (no fabricated field)', async () => {
    const status = await buildController({ 'storage.type': 'local' }).getStatus();
    expect(status.storage.bucket).toBeUndefined();
  });
});

describe('InfraController.exportStorage keeps the export import-able and sweeps it', () => {
  function buildController(storage: Partial<{ createExportStream: jest.Mock }>) {
    return new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      storage as never,
      {} as never,
    );
  }

  // fs.existsSync is globally mocked in this file, so probe the real filesystem via fs.promises.access.
  const exists = (p: string): Promise<boolean> =>
    fs.promises
      .access(p)
      .then(() => true)
      .catch(() => false);

  // Poll (don't sleep a fixed time) so the sweep assertion isn't flaky under CI load.
  const waitForGone = async (p: string, timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (await exists(p)) {
      if (Date.now() - start > timeoutMs) throw new Error(`file was not swept in time: ${p}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  let cwdSpy: jest.SpyInstance | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    cwdSpy?.mockRestore();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    cwdSpy = undefined;
    cwd = undefined;
    delete process.env.STORAGE_EXPORT_TTL_MS;
  });

  it('writes under data/exports (so it stays import-able + survives restart) and TTL-sweeps it', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cwd-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.env.STORAGE_EXPORT_TTL_MS = '30';
    const createExportStream = jest.fn().mockResolvedValue(Readable.from([Buffer.from('archive-bytes')]));
    const controller = buildController({ createExportStream });

    const result = await controller.exportStorage();

    // download is cwd-relative (no absolute host path leak) and stays under data/exports so the import
    // handler — which only accepts paths inside data/ — can still consume it.
    expect(path.isAbsolute(result.download)).toBe(false);
    expect(result.download.startsWith(path.join('data', 'exports'))).toBe(true);
    // Resolve against the (mocked) cwd to check on-disk existence; fs itself uses the real cwd.
    const abs = path.join(cwd, result.download);
    expect(await exists(abs)).toBe(true);

    await waitForGone(abs);
    expect(await exists(abs)).toBe(false);
  });
});

describe('InfraController.requestRestart constrains teardown to managed profiles', () => {
  const buildController = (dockerService: Record<string, unknown>) =>
    new InfraController(
      { get: () => undefined } as never,
      { isInitialized: true } as never,
      { isInitialized: true } as never,
      {} as never, // engineFactory
      dockerService as never,
      { isAvailable: () => Promise.resolve(false) } as never, // cacheService
      { isS3Available: () => false, refreshS3Availability: () => Promise.resolve(false) } as never, // storageService
      { shutdown: jest.fn() } as never, // shutdownService
    );

  it('removes only allowlisted profiles, never an unknown or empty entry', async () => {
    const removeService = jest.fn().mockResolvedValue(true);
    const controller = buildController({
      isDockerAvailable: () => true,
      removeService,
      orchestrateProfiles: jest.fn().mockResolvedValue({}),
    });

    // '' (matches any container by substring) and 'evil' must be dropped; only managed profiles act.
    await controller.requestRestart({ profilesToRemove: ['', 'evil', 'postgres', 'redis'] });

    const removed = removeService.mock.calls.map(call => String((call as unknown[])[0])).sort();
    expect(removed).toEqual(['postgres', 'redis']);
    expect(removed).not.toContain('');
    expect(removed).not.toContain('evil');
  });
});
