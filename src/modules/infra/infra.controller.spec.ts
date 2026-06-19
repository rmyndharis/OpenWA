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
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
  };
});

import { DataSource } from 'typeorm';
import { InfraController } from './infra.controller';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch, BatchStatus } from '../message/entities/message-batch.entity';

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
    const handler = InfraController.prototype[method as keyof InfraController] as object;
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

  it('drops stale postgres keys when switching to sqlite', () => {
    const existing = 'DATABASE_TYPE=postgres\nDATABASE_HOST=oldhost\nDATABASE_PASSWORD=secret\nDATABASE_PORT=5432\n';
    const env = written({ database: { type: 'sqlite' } }, existing);
    expect(env).toContain('DATABASE_TYPE=sqlite');
    expect(env).not.toContain('DATABASE_HOST=');
    expect(env).not.toContain('DATABASE_PASSWORD=');
    expect(env).not.toContain('DATABASE_PORT=');
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
      entities: [Session, Webhook, Message, MessageBatch],
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
    expect(m.from).toBe('a@s.whatsapp.net');
    expect(m.to).toBe('b@s.whatsapp.net');
    expect(m.metadata).toEqual({ ack: 2 });
    const b = await ds.getRepository(MessageBatch).findOneByOrFail({ id: 'b1' });
    expect(b.batchId).toBe('BATCH1');
    expect(b.status).toBe(BatchStatus.COMPLETED);
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
});

describe('InfraController.getConfig (#226)', () => {
  it('returns the saved config shape without echoing secrets', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      'DATABASE_TYPE=postgres\nDATABASE_HOST=db\nDATABASE_PASSWORD=secret\nSESSION_DATA_PATH=./sess\nSTORAGE_TYPE=s3\nS3_ACCESS_KEY_ID=ak\nS3_SECRET_ACCESS_KEY=sk\n',
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
    expect(cfg.storage.type).toBe('s3');
    expect(cfg.storage.s3CredentialsSet).toBe(true);
    // Secrets are never present on the returned object.
    expect(JSON.stringify(cfg)).not.toContain('secret');
    expect(JSON.stringify(cfg)).not.toContain('"ak"');
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

    // Import-able: under <data>/exports — the import handler only accepts paths inside data/.
    expect(result.download.startsWith(path.join(cwd, 'data', 'exports'))).toBe(true);
    expect(await exists(result.download)).toBe(true);

    await waitForGone(result.download);
    expect(await exists(result.download)).toBe(false);
  });
});
