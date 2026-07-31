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
import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InfraController } from './infra.controller';
import { SaveConfigDto } from './dto/save-config.dto';
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
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { recordOsEnvKeys } from '../../config/env-precedence';

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
    const env = writtenEnv({
      database: { type: 'postgres', sslEnabled: true, sslRejectUnauthorized: false, password: 'unit-test-pw' },
    });
    expect(env).toContain('DATABASE_SSL=true');
    expect(env).toContain('DATABASE_SSL_REJECT_UNAUTHORIZED=false');
  });

  it('defaults DATABASE_SSL_REJECT_UNAUTHORIZED=true when SSL is enabled without an explicit flag', () => {
    const env = writtenEnv({ database: { type: 'postgres', sslEnabled: true, password: 'unit-test-pw' } });
    expect(env).toContain('DATABASE_SSL_REJECT_UNAUTHORIZED=true');
  });

  it('omits DATABASE_SSL_REJECT_UNAUTHORIZED when SSL is disabled', () => {
    const env = writtenEnv({ database: { type: 'postgres', sslEnabled: false, password: 'unit-test-pw' } });
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
    const env = written({
      database: { type: 'postgres', builtIn: false, host: 'db', schema: 'openwa', password: 'unit-test-pw' },
    });
    expect(env).toContain('POSTGRES_SCHEMA=openwa');
  });

  it('leaves POSTGRES_SCHEMA untouched when the payload omits it (the runtime default is public)', () => {
    // Per-key merge: an absent field must not reset the stored value. With nothing stored, the
    // key stays out of the file and configuration.ts's own 'public' default applies at boot.
    const fresh = written({ database: { type: 'postgres', builtIn: false, host: 'db', password: 'unit-test-pw' } });
    expect(fresh).not.toContain('POSTGRES_SCHEMA=');
    const preserved = written(
      { database: { type: 'postgres', builtIn: false, host: 'db', password: 'unit-test-pw' } },
      'DATABASE_TYPE=postgres\nPOSTGRES_SCHEMA=openwa\n',
    );
    expect(preserved).toContain('POSTGRES_SCHEMA=openwa');
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

describe('InfraController.saveConfig byte-identical regression (full dashboard payload)', () => {
  // Pins the legitimate behavior: a FULL dashboard save (every section, every field — the exact
  // shape Infrastructure.tsx posts) must produce exactly the same .env.generated bytes as before
  // the per-key merge change. The literal key maps below were derived from the previous
  // implementation's output; any drift in written keys or values fails this gate.
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

  const NOW = '2026-01-02T03:04:05.000Z';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    jest.useRealTimers();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  function expectedEnv(keys: Record<string, string>): string {
    const body = Object.keys(keys)
      .sort()
      .map(k => `${k}=${keys[k]}`);
    return [
      '# OpenWA Configuration',
      `# Generated at ${NOW}`,
      '# Managed via Dashboard > Infrastructure. Values in process env or project .env take precedence.',
      '',
      ...body,
      '',
    ].join('\n');
  }

  function saveAndGetContent(config: unknown, existing: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing);
    (fs.writeFileSync as jest.Mock).mockClear();
    const result = newController().saveConfig(config as never);
    expect(result.saved).toBe(true);
    return ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
  }

  it('all-built-in full save is byte-identical', () => {
    const existing = [
      'DATABASE_TYPE=postgres',
      'POSTGRES_BUILTIN=true',
      'DATABASE_HOST=postgres',
      'DATABASE_PORT=5432',
      'DATABASE_USERNAME=openwa',
      'DATABASE_PASSWORD=openwa',
      'DATABASE_NAME=openwa',
      'POSTGRES_SCHEMA=public',
      'DATABASE_POOL_SIZE=10',
      'DATABASE_SSL=false',
      'REDIS_ENABLED=true',
      'REDIS_BUILTIN=true',
      'REDIS_HOST=redis',
      'REDIS_PORT=6379',
      'QUEUE_ENABLED=true',
      'STORAGE_TYPE=s3',
      'MINIO_BUILTIN=true',
      'S3_ENDPOINT=http://minio:9000',
      'S3_ACCESS_KEY_ID=minioadmin',
      'S3_SECRET_ACCESS_KEY=minioadmin',
      'S3_BUCKET=openwa',
      'S3_REGION=us-east-1',
      'ENGINE_TYPE=whatsapp-web.js',
      'PUPPETEER_HEADLESS=true',
      'SESSION_DATA_PATH=./data/sessions',
      'PUPPETEER_ARGS=--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
      'WEBHOOK_TIMEOUT=5000',
      '',
    ].join('\n');
    // The exact payload the dashboard posts for that saved state (secrets come back empty:
    // "unchanged"). The built-in credentials are exempt from the production secret guard.
    const payload = {
      database: {
        type: 'postgres',
        builtIn: true,
        host: 'postgres',
        port: '5432',
        username: 'openwa',
        password: '',
        database: 'openwa',
        schema: 'public',
        poolSize: 10,
        sslEnabled: false,
        sslRejectUnauthorized: true,
      },
      redis: { enabled: true, builtIn: true, host: 'redis', port: '6379', password: '' },
      queue: { enabled: true },
      storage: {
        type: 's3',
        builtIn: true,
        localPath: '',
        s3Bucket: 'openwa',
        s3Region: 'us-east-1',
        s3AccessKey: '',
        s3SecretKey: '',
        s3Endpoint: 'http://minio:9000',
      },
      engine: {
        type: 'whatsapp-web.js',
        headless: true,
        sessionDataPath: './data/sessions',
        browserArgs: '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
      },
    };

    const content = saveAndGetContent(payload, existing);

    expect(content).toBe(
      expectedEnv({
        DATABASE_HOST: 'postgres',
        DATABASE_NAME: 'openwa',
        DATABASE_PASSWORD: 'openwa',
        DATABASE_POOL_SIZE: '10',
        DATABASE_PORT: '5432',
        DATABASE_SSL: 'false',
        DATABASE_TYPE: 'postgres',
        DATABASE_USERNAME: 'openwa',
        ENGINE_TYPE: 'whatsapp-web.js',
        MINIO_BUILTIN: 'true',
        POSTGRES_BUILTIN: 'true',
        POSTGRES_SCHEMA: 'public',
        PUPPETEER_ARGS: '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu',
        PUPPETEER_HEADLESS: 'true',
        QUEUE_ENABLED: 'true',
        REDIS_BUILTIN: 'true',
        REDIS_ENABLED: 'true',
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379',
        S3_ACCESS_KEY_ID: 'minioadmin',
        S3_BUCKET: 'openwa',
        S3_ENDPOINT: 'http://minio:9000',
        S3_REGION: 'us-east-1',
        S3_SECRET_ACCESS_KEY: 'minioadmin',
        SESSION_DATA_PATH: './data/sessions',
        STORAGE_TYPE: 's3',
        WEBHOOK_TIMEOUT: '5000',
      }),
    );
  });

  it('all-external full save is byte-identical (secrets preserved on empty submission)', () => {
    const existing = [
      'DATABASE_TYPE=postgres',
      'POSTGRES_BUILTIN=false',
      'DATABASE_HOST=db.example.com',
      'DATABASE_PORT=5433',
      'DATABASE_USERNAME=openwauser',
      'DATABASE_PASSWORD=Str0ng!Passw0rd',
      'DATABASE_NAME=openwa',
      'POSTGRES_SCHEMA=openwa',
      'DATABASE_POOL_SIZE=20',
      'DATABASE_SSL=true',
      'DATABASE_SSL_REJECT_UNAUTHORIZED=false',
      'REDIS_ENABLED=true',
      'REDIS_BUILTIN=false',
      'REDIS_HOST=redis.example.com',
      'REDIS_PORT=6380',
      'REDIS_PASSWORD=r3dis-secret',
      'QUEUE_ENABLED=false',
      'STORAGE_TYPE=s3',
      'MINIO_BUILTIN=false',
      'S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com',
      'S3_ACCESS_KEY_ID=AKIAEXAMPLE123',
      'S3_SECRET_ACCESS_KEY=s3-super-secret',
      'S3_BUCKET=mybucket',
      'S3_REGION=eu-west-1',
      'ENGINE_TYPE=baileys',
      'PUPPETEER_HEADLESS=false',
      'SESSION_DATA_PATH=/var/lib/openwa/sessions',
      'PUPPETEER_ARGS=--no-sandbox',
      '',
    ].join('\n');
    const payload = {
      database: {
        type: 'postgres',
        builtIn: false,
        host: 'db.example.com',
        port: '5433',
        username: 'openwauser',
        password: '',
        database: 'openwa',
        schema: 'openwa',
        poolSize: 20,
        sslEnabled: true,
        sslRejectUnauthorized: false,
      },
      redis: { enabled: true, builtIn: false, host: 'redis.example.com', port: '6380', password: '' },
      queue: { enabled: false },
      storage: {
        type: 's3',
        builtIn: false,
        localPath: '',
        s3Bucket: 'mybucket',
        s3Region: 'eu-west-1',
        s3AccessKey: '',
        s3SecretKey: '',
        s3Endpoint: 'https://s3.eu-west-1.amazonaws.com',
      },
      engine: {
        type: 'baileys',
        headless: false,
        sessionDataPath: '/var/lib/openwa/sessions',
        browserArgs: '--no-sandbox',
      },
    };

    const content = saveAndGetContent(payload, existing);

    expect(content).toBe(
      expectedEnv({
        DATABASE_HOST: 'db.example.com',
        DATABASE_NAME: 'openwa',
        DATABASE_PASSWORD: 'Str0ng!Passw0rd',
        DATABASE_POOL_SIZE: '20',
        DATABASE_PORT: '5433',
        DATABASE_SSL: 'true',
        DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
        DATABASE_TYPE: 'postgres',
        DATABASE_USERNAME: 'openwauser',
        ENGINE_TYPE: 'baileys',
        MINIO_BUILTIN: 'false',
        POSTGRES_BUILTIN: 'false',
        POSTGRES_SCHEMA: 'openwa',
        PUPPETEER_ARGS: '--no-sandbox',
        PUPPETEER_HEADLESS: 'false',
        QUEUE_ENABLED: 'false',
        REDIS_BUILTIN: 'false',
        REDIS_ENABLED: 'true',
        REDIS_HOST: 'redis.example.com',
        REDIS_PASSWORD: 'r3dis-secret',
        REDIS_PORT: '6380',
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLE123',
        S3_BUCKET: 'mybucket',
        S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
        S3_REGION: 'eu-west-1',
        S3_SECRET_ACCESS_KEY: 's3-super-secret',
        SESSION_DATA_PATH: '/var/lib/openwa/sessions',
        STORAGE_TYPE: 's3',
      }),
    );
  });
});

describe('InfraController.saveConfig per-key merge (partial payloads)', () => {
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

  it('a queue-only save does not touch the redis section', () => {
    const env = written(
      { queue: { enabled: true } },
      'REDIS_ENABLED=true\nREDIS_BUILTIN=true\nREDIS_HOST=redis\nREDIS_PORT=6379\nQUEUE_ENABLED=false\n',
    );
    expect(env).toContain('QUEUE_ENABLED=true');
    expect(env).toContain('REDIS_ENABLED=true');
    expect(env).toContain('REDIS_BUILTIN=true');
    expect(env).toContain('REDIS_HOST=redis');
    expect(env).toContain('REDIS_PORT=6379');
  });

  it('a redis-only save does not touch the queue section or force the redis flags', () => {
    const env = written(
      { redis: { host: 'redis2.example.com' } },
      'REDIS_ENABLED=true\nREDIS_BUILTIN=false\nREDIS_HOST=redis1.example.com\nQUEUE_ENABLED=true\n',
    );
    expect(env).toContain('REDIS_HOST=redis2.example.com');
    expect(env).toContain('REDIS_ENABLED=true');
    expect(env).toContain('REDIS_BUILTIN=false');
    expect(env).toContain('QUEUE_ENABLED=true');
  });

  it('a partial database save keeps unmentioned keys (pool size, schema, stored password)', () => {
    const existing =
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=old.example.com\nDATABASE_PASSWORD=keepme\nDATABASE_POOL_SIZE=25\nPOSTGRES_SCHEMA=openwa\n';
    const env = written({ database: { type: 'postgres', host: 'new.example.com' } }, existing);
    expect(env).toContain('DATABASE_HOST=new.example.com');
    expect(env).toContain('DATABASE_POOL_SIZE=25');
    expect(env).toContain('POSTGRES_SCHEMA=openwa');
    expect(env).toContain('DATABASE_PASSWORD=keepme');
  });

  it('a partial storage save keeps the stored S3 region instead of resetting it to the default', () => {
    const existing =
      'STORAGE_TYPE=s3\nMINIO_BUILTIN=false\nS3_BUCKET=old-bucket\nS3_REGION=eu-west-1\nS3_ACCESS_KEY_ID=ak-strong\nS3_SECRET_ACCESS_KEY=sk-strong\n';
    const env = written({ storage: { type: 's3', s3Bucket: 'new-bucket' } }, existing);
    expect(env).toContain('S3_BUCKET=new-bucket');
    expect(env).toContain('S3_REGION=eu-west-1');
    expect(env).toContain('S3_ACCESS_KEY_ID=ak-strong');
  });

  it('a partial engine save keeps the stored session path and browser args', () => {
    const env = written(
      { engine: { headless: false } },
      'SESSION_DATA_PATH=./old-path\nPUPPETEER_ARGS=--custom-flag\n',
    );
    expect(env).toContain('PUPPETEER_HEADLESS=false');
    expect(env).toContain('SESSION_DATA_PATH=./old-path');
    expect(env).toContain('PUPPETEER_ARGS=--custom-flag');
  });
});

describe('InfraController.saveConfig built-in/external mode flips and the save-time secret guard', () => {
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

  function expectRejected(config: unknown, existing: string | undefined, match: RegExp): void {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    expect(() => newController().saveConfig(config as never)).toThrow(match);
    // A rejected save must leave the previous file untouched.
    expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  }

  const BUILTIN_POSTGRES_ENV =
    'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_PORT=5432\nDATABASE_USERNAME=openwa\nDATABASE_PASSWORD=openwa\nDATABASE_NAME=openwa\nPOSTGRES_SCHEMA=public\n';
  const BUILTIN_MINIO_ENV =
    'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=http://minio:9000\nS3_ACCESS_KEY_ID=minioadmin\nS3_SECRET_ACCESS_KEY=minioadmin\nS3_BUCKET=openwa\nS3_REGION=us-east-1\n';

  it('flipping Postgres built-in -> external with a fresh password drops the bundled password', () => {
    const env = written(
      {
        database: {
          type: 'postgres',
          builtIn: false,
          host: 'db.example.com',
          username: 'app',
          password: 'Sup3rSecret!',
          database: 'appdb',
        },
      },
      BUILTIN_POSTGRES_ENV,
    );
    expect(env).toContain('POSTGRES_BUILTIN=false');
    expect(env).toContain('DATABASE_HOST=db.example.com');
    expect(env).toContain('DATABASE_PASSWORD=Sup3rSecret!');
    // No trace of the bundled 'openwa' credential may survive the flip.
    expect(env).not.toContain('openwa');
  });

  it('rejects flipping Postgres built-in -> external without a fresh password instead of crash-looping', () => {
    // Without the mode-flip drop + save-time guard this saved the bundled 'openwa' password into
    // the external config; the production boot guard then refused to start and the dashboard died
    // with it. The save itself must now fail with a 400 naming the variable.
    expectRejected(
      { database: { type: 'postgres', builtIn: false, host: 'db.example.com', username: 'app', database: 'appdb' } },
      BUILTIN_POSTGRES_ENV,
      /DATABASE_PASSWORD/,
    );
  });

  it('rejects a blank-password external Postgres on a fresh setup (the sibling blank-password case)', () => {
    expectRejected(
      { database: { type: 'postgres', builtIn: false, host: 'db.example.com', password: '' } },
      undefined,
      /DATABASE_PASSWORD/,
    );
  });

  it('rejects an external Postgres using a known-default password', () => {
    expectRejected(
      { database: { type: 'postgres', builtIn: false, host: 'db.example.com', password: 'password' } },
      undefined,
      /DATABASE_PASSWORD/,
    );
  });

  it('the rejection is a 400 BadRequestException, not a masked {saved:false} 200', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();
    expect(() =>
      newController().saveConfig({ database: { type: 'postgres', builtIn: false, host: 'db' } } as never),
    ).toThrow(BadRequestException);
  });

  it('flipping storage built-in -> external with fresh credentials drops the bundled ones', () => {
    const env = written(
      {
        storage: {
          type: 's3',
          builtIn: false,
          s3Bucket: 'prod-bucket',
          s3Region: 'ap-southeast-1',
          s3AccessKey: 'AKIANEWEXAMPLE',
          s3SecretKey: 'brand-new-secret',
          s3Endpoint: 'https://s3.ap-southeast-1.amazonaws.com',
        },
      },
      BUILTIN_MINIO_ENV,
    );
    expect(env).toContain('MINIO_BUILTIN=false');
    expect(env).toContain('S3_ACCESS_KEY_ID=AKIANEWEXAMPLE');
    expect(env).toContain('S3_SECRET_ACCESS_KEY=brand-new-secret');
    expect(env).toContain('S3_ENDPOINT=https://s3.ap-southeast-1.amazonaws.com');
    expect(env).not.toContain('minioadmin');
    expect(env).not.toContain('http://minio:9000');
  });

  it('flipping storage built-in -> external (AWS) with a blank endpoint drops the stale MinIO endpoint', () => {
    const env = written(
      {
        storage: {
          type: 's3',
          builtIn: false,
          s3Bucket: 'prod-bucket',
          s3AccessKey: 'AKIANEWEXAMPLE',
          s3SecretKey: 'brand-new-secret',
          s3Endpoint: '',
        },
      },
      BUILTIN_MINIO_ENV,
    );
    expect(env).not.toContain('S3_ENDPOINT=');
    expect(env).toContain('S3_ACCESS_KEY_ID=AKIANEWEXAMPLE');
  });

  it('rejects flipping storage built-in -> external without fresh credentials', () => {
    expectRejected(
      {
        storage: {
          type: 's3',
          builtIn: false,
          s3Bucket: 'prod-bucket',
          s3AccessKey: '',
          s3SecretKey: '',
          s3Endpoint: '',
        },
      },
      BUILTIN_MINIO_ENV,
      /S3_ACCESS_KEY, S3_SECRET_KEY/,
    );
  });

  it('rejects external S3 using the known-default minioadmin credentials', () => {
    expectRejected(
      {
        storage: {
          type: 's3',
          builtIn: false,
          s3Bucket: 'b',
          s3AccessKey: 'minioadmin',
          s3SecretKey: 'minioadmin',
          s3Endpoint: 'https://minio.example.com',
        },
      },
      undefined,
      /S3_ACCESS_KEY, S3_SECRET_KEY/,
    );
  });

  it('flipping Redis external -> built-in drops the stale external password', () => {
    const env = written(
      { redis: { enabled: true, builtIn: true } },
      'REDIS_ENABLED=true\nREDIS_BUILTIN=false\nREDIS_HOST=redis.example.com\nREDIS_PORT=6379\nREDIS_PASSWORD=hunter2\n',
    );
    expect(env).toContain('REDIS_BUILTIN=true');
    expect(env).toContain('REDIS_HOST=redis');
    // The bundled Redis runs without auth; a carried-over password would make the client AUTH
    // against a passwordless server on the next boot.
    expect(env).not.toContain('REDIS_PASSWORD=');
  });

  it('rejects a placeholder Redis password at save time', () => {
    expectRejected(
      { redis: { enabled: true, builtIn: false, host: 'redis.example.com', password: 'password' } },
      undefined,
      /REDIS_PASSWORD/,
    );
  });

  it('still saves built-in modes: the bundled credentials stay exempt from the guard', () => {
    const env = written({
      database: { type: 'postgres', builtIn: true },
      storage: { type: 's3', builtIn: true },
    });
    expect(env).toContain('DATABASE_PASSWORD=openwa');
    expect(env).toContain('POSTGRES_BUILTIN=true');
    expect(env).toContain('S3_ACCESS_KEY_ID=minioadmin');
    expect(env).toContain('MINIO_BUILTIN=true');
  });

  it('an absent builtIn field inherits built-in mode without clobbering a stored custom password', () => {
    // Secrets are never echoed back to the form, so an absent password field means "unchanged".
    // Merely inheriting the built-in mode must not re-stamp the bundled 'openwa' over a custom
    // password (e.g. an operator who re-keyed the bundled container via POSTGRES_PASSWORD).
    const env = written(
      { database: { type: 'postgres', poolSize: 25 } },
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_PORT=5432\nDATABASE_USERNAME=openwa\nDATABASE_PASSWORD=CustomPw123!\nDATABASE_NAME=openwa\nPOSTGRES_SCHEMA=public\n',
    );
    expect(env).toContain('POSTGRES_BUILTIN=true');
    expect(env).toContain('DATABASE_PASSWORD=CustomPw123!');
    expect(env).toContain('DATABASE_POOL_SIZE=25');
  });

  it('an explicit password wins while the built-in mode is only inherited', () => {
    const env = written(
      { database: { type: 'postgres', password: 'NewPw456!' } },
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_PASSWORD=openwa\nDATABASE_NAME=openwa\n',
    );
    expect(env).toContain('DATABASE_PASSWORD=NewPw456!');
    expect(env).not.toContain('DATABASE_PASSWORD=openwa');
  });

  it('an explicit builtIn:true keeps a re-keyed bundled password (the dashboard always sends builtIn)', () => {
    // Infrastructure.tsx sends `database.builtIn` on every save and never echoes the password back,
    // so treating "explicit builtIn:true + no password" as a reset re-wrote a re-keyed container's
    // credential on each save, breaking the next boot's DB auth.
    const env = written(
      { database: { type: 'postgres', builtIn: true } },
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_PASSWORD=CustomPw123!\nDATABASE_NAME=openwa\n',
    );
    expect(env).toContain('DATABASE_PASSWORD=CustomPw123!');
  });

  it('does not carry an EXTERNAL password into the bundled container when switching to built-in', () => {
    // The stored secret belongs to the external DB; the bundled container is seeded with 'openwa'
    // unless the operator re-keys it, so switching modes must reset rather than inherit.
    const env = written(
      { database: { type: 'postgres', builtIn: true } },
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.example.com\nDATABASE_PASSWORD=ExternalPw!\nDATABASE_NAME=appdb\n',
    );
    expect(env).toContain('DATABASE_PASSWORD=openwa');
    expect(env).not.toContain('ExternalPw!');
  });

  // The guard must evaluate what the next boot would SEE: load-env.ts loads with dotenv
  // override:false, so a value in the container environment (compose `environment:`) wins over the
  // saved file. Snapshot + clear every guard-relevant key so these tests are hermetic.
  describe('process-environment precedence', () => {
    const GUARD_ENV_KEYS = [
      'DATABASE_TYPE',
      'DATABASE_PASSWORD',
      'POSTGRES_BUILTIN',
      'DATABASE_HOST',
      'STORAGE_TYPE',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_ENDPOINT',
      'MINIO_BUILTIN',
      'REDIS_PASSWORD',
    ];
    let savedEnv: Array<[string, string | undefined]>;
    beforeEach(() => {
      savedEnv = GUARD_ENV_KEYS.map(k => [k, process.env[k]]);
      for (const k of GUARD_ENV_KEYS) delete process.env[k];
    });
    afterEach(() => {
      for (const [k, v] of savedEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('accepts an external Postgres whose strong password comes from the process environment', () => {
      // The compose deployment the guard used to refuse on EVERY save: the file still holds the
      // bundled built-in credentials, but boot would see the env password, not the file's.
      process.env.DATABASE_PASSWORD = 'Sup3rSecret!';
      const env = written(
        {
          database: { type: 'postgres', builtIn: false, host: 'db.example.com', username: 'app', database: 'appdb' },
        },
        BUILTIN_POSTGRES_ENV,
      );
      expect(env).toContain('POSTGRES_BUILTIN=false');
      expect(env).toContain('DATABASE_HOST=db.example.com');
      // The stale bundled password is still dropped from the file — the environment supplies it.
      expect(env).not.toContain('DATABASE_PASSWORD');
    });

    it('a blank process-env forward counts as unset, so a weak merged config is still rejected', () => {
      // Compose renders `- DATABASE_PASSWORD=${DATABASE_PASSWORD:-}` as an empty value when the
      // operator sets nothing; boot clears that blank (clearBlankEnv) and falls to the file. The
      // guard does the same — a blank forward can neither mask a weak file value nor supply one.
      process.env.DATABASE_PASSWORD = '';
      expectRejected(
        {
          database: { type: 'postgres', builtIn: false, host: 'db.example.com', username: 'app', database: 'appdb' },
        },
        BUILTIN_POSTGRES_ENV,
        /DATABASE_PASSWORD/,
      );
    });

    it('a weak process-env value wins over a strong saved one and is still rejected', () => {
      // Precedence cuts both ways: boot would see the env value, so a weak env password must not be
      // rescued by a strong one sitting in the file.
      process.env.DATABASE_PASSWORD = 'password';
      expectRejected(
        { queue: { enabled: true } },
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.example.com\nDATABASE_PASSWORD=Str0ngSaved!\n',
        /DATABASE_PASSWORD/,
      );
    });

    // The cases above delete every guard key from process.env, which cannot happen in production:
    // load-env merges data/.env.generated INTO process.env at boot, so the file's own values are
    // sitting there while this save runs. Reading them back as if they were an orchestrator
    // override makes the guard validate the config being REPLACED.
    describe('saved-file values echoed in process.env are not mistaken for host overrides', () => {
      afterEach(() => {
        // Restore the permissive snapshot the rest of the file assumes.
        recordOsEnvKeys(process.env);
      });

      it('refuses a built-in -> external flip that keeps the bundled password (boot would crash-loop)', () => {
        recordOsEnvKeys({}); // the host supplied nothing; everything below came from the file
        process.env.DATABASE_TYPE = 'postgres';
        process.env.POSTGRES_BUILTIN = 'true';
        process.env.DATABASE_HOST = 'postgres';
        process.env.DATABASE_PASSWORD = 'openwa';
        expectRejected(
          {
            database: { type: 'postgres', builtIn: false, host: 'db.example.com', username: 'app', database: 'appdb' },
          },
          BUILTIN_POSTGRES_ENV,
          /DATABASE_PASSWORD/,
        );
      });

      it('still honors a genuine host override of the same key', () => {
        recordOsEnvKeys({ DATABASE_PASSWORD: 'Sup3rSecret!' });
        process.env.DATABASE_PASSWORD = 'Sup3rSecret!';
        const env = written(
          {
            database: { type: 'postgres', builtIn: false, host: 'db.example.com', username: 'app', database: 'appdb' },
          },
          BUILTIN_POSTGRES_ENV,
        );
        expect(env).toContain('DATABASE_HOST=db.example.com');
      });
    });
  });
});

describe('InfraController.saveConfig persists strictly-coerced form booleans', () => {
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

  it("persists 'false' for every boolean field when the body arrives form-encoded", async () => {
    // The global urlencoded parser delivers scalars as strings and the ValidationPipe runs with
    // enableImplicitConversion, which used to turn every non-empty string — including 'false' —
    // into `true`. SaveConfigDto's @ToStrictBoolean fields must map 'false' to a real false so the
    // file gets 'false', not a silently-enabled feature on the next boot.
    const formPayload = {
      database: {
        type: 'postgres',
        builtIn: 'false',
        host: 'db.example.com',
        password: 'unit-test-pw',
        sslEnabled: 'true',
        sslRejectUnauthorized: 'false',
      },
      redis: { enabled: 'false', builtIn: 'false' },
      queue: { enabled: 'false' },
      storage: { type: 's3', builtIn: 'false', s3Bucket: 'b', s3AccessKey: 'ak-strong', s3SecretKey: 'sk-strong' },
      engine: { headless: 'false' },
    };
    // Mirror the real pipe: implicit conversion on, whitelist validation (src/config/app-validation.ts).
    const instance = plainToInstance(SaveConfigDto, formPayload, { enableImplicitConversion: true });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(instance);
    const env = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];

    expect(env).toContain('POSTGRES_BUILTIN=false');
    expect(env).toContain('DATABASE_SSL=true');
    expect(env).toContain('DATABASE_SSL_REJECT_UNAUTHORIZED=false');
    expect(env).toContain('REDIS_ENABLED=false');
    expect(env).toContain('REDIS_BUILTIN=false');
    expect(env).toContain('QUEUE_ENABLED=false');
    expect(env).toContain('MINIO_BUILTIN=false');
    expect(env).toContain('PUPPETEER_HEADLESS=false');
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
      type: 'better-sqlite3',
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

  it('round-trips the ingress dispatch-lifecycle columns so a restored pending event still replays', async () => {
    await seedSession('s1');
    const ingressRepo = ds.getRepository(IngressEvent);
    // A pending event (still carrying its payload, awaiting reconciler replay) and a retired one
    // (dispatch outcome recorded, payload slimmed to NULL).
    await ingressRepo.save(
      ingressRepo.create({
        id: 'ie-pending',
        instanceId: 'acct1',
        pluginId: 'chatwoot',
        providerDeliveryId: 'dlv-1',
        route: 'chatwoot/acct1',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        payloadHash: 'abc123',
        sessionId: 's1',
        dispatchState: 'pending',
        dispatchAttempts: 2,
        lastDispatchAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    );
    await ingressRepo.save(
      ingressRepo.create({
        id: 'ie-retired',
        instanceId: 'acct1',
        pluginId: 'chatwoot',
        providerDeliveryId: 'dlv-2',
        route: 'chatwoot/acct1',
        payload: null,
        payloadHash: 'def456',
        sessionId: 's1',
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        lastDispatchAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.ingressEvents).toBe(2);

    await ingressRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.ingressEvents).toBe(2);

    // A restored 'pending' row that lost its dispatchState would read as NULL ("not watched"): the
    // reconciler would never replay it while the dedup key still blocked the provider's retry.
    const pending = await ingressRepo.findOneByOrFail({ id: 'ie-pending' });
    expect(pending.dispatchState).toBe('pending');
    expect(pending.dispatchAttempts).toBe(2);
    expect(pending.lastDispatchAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
    expect(pending.payloadHash).toBe('abc123');
    expect(pending.payload).toEqual({ headers: {}, query: {}, body: '{}', rawBody: '{}' });

    const retired = await ingressRepo.findOneByOrFail({ id: 'ie-retired' });
    expect(retired.dispatchState).toBe('dispatched');
    expect(retired.payloadHash).toBe('def456');
    // A retired payload must stay NULL — re-materializing it as '{}' would make the slimmed dedup
    // row read as a pending event with an empty body.
    expect(retired.payload).toBeNull();
  });

  it('imports a pre-lifecycle backup (no dispatch columns) as not-watched legacy rows', async () => {
    await seedSession('s1');
    const res = await controller.importData({
      tables: {
        ingressEvents: [
          {
            id: 'ie-legacy',
            instanceId: 'acct1',
            pluginId: 'chatwoot',
            providerDeliveryId: 'dlv-9',
            route: 'chatwoot/acct1',
            payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
            sessionId: 's1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ] as never,
      },
    });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    // Columns absent from an older backup import as NULL/0 — the same "not watched" reading legacy
    // rows have by design (the reconciler never sweeps them, so an upgrade can't mass-replay history).
    const legacy = await ds.getRepository(IngressEvent).findOneByOrFail({ id: 'ie-legacy' });
    expect(legacy.dispatchState).toBeNull();
    expect(legacy.dispatchAttempts).toBe(0);
    expect(legacy.lastDispatchAt).toBeNull();
    expect(legacy.payloadHash).toBeNull();
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
      type: 'better-sqlite3',
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

  // The messages import column list must carry every later-added column; `author` (the group
  // sender identity) was the one that drifted — a restored backup silently lost all attribution.
  it('restores the group-sender author column on a backup→restore', async () => {
    await seedSession('s1');
    const msgRepo = ds.getRepository(Message);
    await msgRepo.save(
      msgRepo.create({
        sessionId: 's1',
        waMessageId: 'WA-A1',
        chatId: '120363@g.us',
        chatName: 'Alice',
        author: '628111@c.us',
        from: '120363@g.us',
        to: 'me@c.us',
        body: 'hello',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: 1700000000,
      }),
    );

    const dump = await controller.exportData();
    await msgRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    const restored = await msgRepo.findOneByOrFail({ waMessageId: 'WA-A1' });
    expect(restored.author).toBe('628111@c.us');
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

describe('InfraController.sweepStaleExportArchives (boot orphan sweep)', () => {
  function buildController() {
    return new InfraController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  // A name in exactly the shape exportStorage writes: storage-export-<epochMs>-<uuid>.tar.gz.
  const archiveName = (epochMs: number): string =>
    `storage-export-${epochMs}-3b241101-e2bb-4255-8caf-4136c566a962.tar.gz`;

  const exists = (p: string): Promise<boolean> =>
    fs.promises
      .access(p)
      .then(() => true)
      .catch(() => false);

  let dir: string | undefined;
  let cwdSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-exports-'));
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS;
  });

  const touch = async (name: string): Promise<string> => {
    const p = path.join(dir!, name);
    await fs.promises.writeFile(p, 'archive-bytes');
    return p;
  };

  it('deletes export archives older than the default 24h but keeps young archives and non-export files', async () => {
    const stale = await touch(archiveName(Date.now() - 25 * 60 * 60 * 1000));
    const young = await touch(archiveName(Date.now() - 60 * 1000));
    const operatorImportCandidate = await touch('to-import.tar.gz');
    // Near-miss names are NOT ours: no uuid / wrong extension / different prefix.
    const noUuid = await touch(`storage-export-${Date.now() - 48 * 60 * 60 * 1000}.tar.gz`);
    const wrongExt = await touch(archiveName(Date.now() - 48 * 60 * 60 * 1000).replace(/\.tar\.gz$/, '.zip'));
    const otherPrefix = await touch(`backup-${Date.now() - 48 * 60 * 60 * 1000}.tar.gz`);

    await buildController().sweepStaleExportArchives(dir);

    expect(await exists(stale)).toBe(false);
    expect(await exists(young)).toBe(true);
    expect(await exists(operatorImportCandidate)).toBe(true);
    expect(await exists(noUuid)).toBe(true);
    expect(await exists(wrongExt)).toBe(true);
    expect(await exists(otherPrefix)).toBe(true);
  });

  it('takes the max age from STORAGE_EXPORT_SWEEP_MAX_AGE_MS', async () => {
    const oneHourOld = archiveName(Date.now() - 60 * 60 * 1000);

    // A 30-minute cap sweeps a 1-hour-old archive...
    process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS = '1800000';
    const swept = await touch(oneHourOld);
    await buildController().sweepStaleExportArchives(dir);
    expect(await exists(swept)).toBe(false);

    // ...while a 2-hour cap keeps it.
    process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS = '7200000';
    const kept = await touch(oneHourOld);
    await buildController().sweepStaleExportArchives(dir);
    expect(await exists(kept)).toBe(true);
  });

  it('resolves quietly when the exports directory does not exist yet', async () => {
    await expect(buildController().sweepStaleExportArchives(path.join(dir!, 'never-created'))).resolves.toBeUndefined();
  });

  it('runs the sweep against <cwd>/data/exports at application bootstrap', async () => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(dir!);
    const exportDir = path.join(dir!, 'data', 'exports');
    await fs.promises.mkdir(exportDir, { recursive: true });
    const stale = path.join(exportDir, archiveName(Date.now() - 25 * 60 * 60 * 1000));
    await fs.promises.writeFile(stale, 'archive-bytes');

    await buildController().onApplicationBootstrap();

    expect(await exists(stale)).toBe(false);
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

  it('tears down only allowlisted profiles, never an unknown or empty entry', async () => {
    const stopManagedService = jest.fn().mockResolvedValue(true);
    const controller = buildController({
      isDockerAvailable: () => true,
      stopManagedService,
      orchestrateProfiles: jest.fn().mockResolvedValue({}),
    });

    // '' (matches any container by substring) and 'evil' must be dropped; only managed profiles act.
    await controller.requestRestart({ profilesToRemove: ['', 'evil', 'postgres', 'redis'] });

    const torn = stopManagedService.mock.calls.map(call => String((call as unknown[])[0])).sort();
    expect(torn).toEqual(['postgres', 'redis']);
    expect(torn).not.toContain('');
    expect(torn).not.toContain('evil');
  });

  it('reports teardown as stopped-not-removed, with honest per-profile errors', async () => {
    const stopManagedService = jest
      .fn()
      .mockResolvedValueOnce(true) // postgres stops cleanly
      .mockResolvedValueOnce(false); // redis fails
    const controller = buildController({
      isDockerAvailable: () => true,
      stopManagedService,
      orchestrateProfiles: jest.fn().mockResolvedValue({}),
    });

    const result = await controller.requestRestart({ profilesToRemove: ['postgres', 'redis'] });

    // Teardown is stop-only (containers are retained, never deleted) — the payload must say so.
    expect(result.removal).toEqual({
      stopped: ['postgres'],
      errors: ['Failed to stop redis'],
    });
    expect(JSON.stringify(result.removal)).not.toContain('removed');
  });

  it('starts only allowlisted profiles, never an unknown entry (symmetry with teardown)', async () => {
    const orchestrateProfiles = jest.fn().mockResolvedValue({});
    const controller = buildController({
      isDockerAvailable: () => true,
      stopManagedService: jest.fn().mockResolvedValue(true),
      orchestrateProfiles,
    });

    // A non-managed name must be dropped before reaching orchestrateProfiles, exactly as teardown
    // drops it before reaching stopManagedService — so start cannot select an unrelated container.
    await controller.requestRestart({ profiles: ['postgres', 'not-managed'] });

    expect(orchestrateProfiles).toHaveBeenCalledTimes(1);
    expect(orchestrateProfiles).toHaveBeenCalledWith(['postgres']);
  });

  it('writes only allowlisted profiles to the no-Docker signal file (symmetry with the Docker path)', async () => {
    const writeFileSync = fs.writeFileSync as jest.Mock;
    writeFileSync.mockClear();
    const controller = buildController({ isDockerAvailable: () => false });

    // The signal file is consumed by an external host script — it must never be handed a name the
    // in-process Docker path would have refused.
    await controller.requestRestart({ profiles: ['postgres', 'not-managed'], profilesToRemove: ['evil', 'redis'] });

    const written = (writeFileSync.mock.calls as Array<[unknown, unknown]>).find(call =>
      String(call[0]).endsWith('.orchestration-request.json'),
    );
    expect(written).toBeDefined();
    const payload = JSON.parse(String(written![1])) as { profiles: string[]; profilesToRemove: string[] };
    expect(payload.profiles).toEqual(['postgres']);
    expect(payload.profilesToRemove).toEqual(['redis']);
  });
});

// C002: the infra module exposed sensitive ADMIN operations (credential config write, restart/Docker
// orchestration, full-DB + storage export/import) with no audit trail. Each now emits an AuditAction.
describe('InfraController C002 audit trail (light-dependency handlers)', () => {
  const makeAudit = (): { logInfo: jest.Mock } => ({ logInfo: jest.fn().mockResolvedValue(null) });

  // Positional constructor: (config, mainDs, dataDs, engineFactory, dockerService, cacheService,
  // storageService, shutdownService, webhookQueue?, auditService?). auditService is the last @Optional arg.
  const build = (
    audit: { logInfo: jest.Mock },
    overrides: Partial<{
      config: unknown;
      dataDs: unknown;
      engineFactory: unknown;
      dockerService: unknown;
      storageService: unknown;
      shutdownService: unknown;
    }> = {},
  ): InfraController =>
    new InfraController(
      (overrides.config ?? {}) as never,
      {} as never,
      (overrides.dataDs ?? {}) as never,
      (overrides.engineFactory ?? {}) as never,
      (overrides.dockerService ?? {}) as never,
      {} as never,
      (overrides.storageService ?? {}) as never,
      (overrides.shutdownService ?? {}) as never,
      undefined as never,
      audit as never,
    );

  it('saveConfig emits INFRA_CONFIG_SAVED without leaking secret values into the metadata', () => {
    const audit = makeAudit();
    build(audit).saveConfig({ database: { type: 'postgres', host: 'db', password: 'topsecret' } } as never);
    expect(audit.logInfo).toHaveBeenCalledTimes(1);
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { sections: string[] } }]>;
    const [action, ctx] = calls[0];
    expect(action).toBe(AuditAction.INFRA_CONFIG_SAVED);
    expect(ctx.metadata.sections).toContain('database');
    // Only section names + profiles are recorded — never a secret value.
    expect(JSON.stringify(ctx)).not.toContain('topsecret');
  });

  it('saveConfig does NOT emit when the payload is rejected (unknown engine)', () => {
    const audit = makeAudit();
    const controller = build(audit, { engineFactory: { getAvailableEngines: () => [{ id: 'baileys' }] } });
    expect(() => controller.saveConfig({ engine: { type: 'bogus' } })).toThrow(BadRequestException);
    expect(audit.logInfo).not.toHaveBeenCalled();
  });

  it('requestRestart emits INFRA_RESTART_REQUESTED with the requested profiles', async () => {
    const audit = makeAudit();
    const controller = build(audit, {
      config: { get: () => undefined },
      dockerService: { isDockerAvailable: () => false },
      shutdownService: { shutdown: jest.fn() },
    });
    await controller.requestRestart({ profiles: ['postgres'], profilesToRemove: [] });
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { profiles: string[] } }]>;
    expect(calls[0][0]).toBe(AuditAction.INFRA_RESTART_REQUESTED);
    expect(calls[0][1].metadata.profiles).toEqual(['postgres']);
  });

  it('exportData emits INFRA_DATA_EXPORTED with per-table counts', async () => {
    const audit = makeAudit();
    const controller = build(audit, {
      config: { get: (k: string, d?: unknown) => (k === 'dataDatabase.type' ? 'sqlite' : d) },
      dataDs: { query: jest.fn().mockResolvedValue([]) },
    });
    await controller.exportData();
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { counts: { sessions: number } } }]>;
    expect(calls[0][0]).toBe(AuditAction.INFRA_DATA_EXPORTED);
    expect(calls[0][1].metadata.counts.sessions).toBe(0);
  });

  it('importStorage emits INFRA_STORAGE_IMPORTED with the imported file count', async () => {
    const audit = makeAudit();
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/x.tar.gz');
    try {
      const storageService = { importFromStream: jest.fn().mockResolvedValue(5), getCurrentStorageType: () => 'local' };
      await build(audit, { storageService }).importStorage({ filePath: 'data/exports/x.tar.gz' });
      const calls = audit.logInfo.mock.calls as Array<
        [AuditAction, { metadata: { count: number; storageType: string } }]
      >;
      expect(calls[0][0]).toBe(AuditAction.INFRA_STORAGE_IMPORTED);
      expect(calls[0][1].metadata).toEqual({ count: 5, storageType: 'local' });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });

  it('exportStorage emits INFRA_STORAGE_EXPORTED', async () => {
    const audit = makeAudit();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-audit-'));
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.env.STORAGE_EXPORT_TTL_MS = '30';
    try {
      const storageService = { createExportStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('x')])) };
      await build(audit, { storageService }).exportStorage();
      const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { download: string } }]>;
      expect(calls[0][0]).toBe(AuditAction.INFRA_STORAGE_EXPORTED);
      expect(typeof calls[0][1].metadata.download).toBe('string');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      delete process.env.STORAGE_EXPORT_TTL_MS;
    }
  });
});

describe('InfraController C002 audit trail — import emits only on a committed restore', () => {
  let ds: DataSource;
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  const build = (audit: { logInfo: jest.Mock }): InfraController =>
    new InfraController(
      cfg as never,
      {} as never,
      ds,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      audit as never,
    );

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
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

  it('emits INFRA_DATA_EXPORTED then INFRA_DATA_IMPORTED across a successful round-trip', async () => {
    await seedSession('s1');
    const audit = { logInfo: jest.fn().mockResolvedValue(null) };
    const controller = build(audit);
    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);
    const actions = (audit.logInfo.mock.calls as Array<[AuditAction, unknown]>).map(c => c[0]);
    expect(actions).toContain(AuditAction.INFRA_DATA_EXPORTED);
    expect(actions).toContain(AuditAction.INFRA_DATA_IMPORTED);
  });

  it('does NOT emit INFRA_DATA_IMPORTED when an empty backup is refused (no data changed)', async () => {
    await seedSession('s1');
    const audit = { logInfo: jest.fn().mockResolvedValue(null) };
    const res = await build(audit).importData({ tables: {} });
    expect(res.imported).toBe(false);
    const actions = (audit.logInfo.mock.calls as Array<[AuditAction, unknown]>).map(c => c[0]);
    expect(actions).not.toContain(AuditAction.INFRA_DATA_IMPORTED);
  });
});

describe('InfraController.exportData optional-table strictness', () => {
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  const build = (query: jest.Mock) =>
    new InfraController(
      cfg as never,
      {} as never,
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  it('rethrows a non-missing-table error (lock/IO/timeout) instead of reporting a partial export as complete', async () => {
    // A lock on ONE optional table must fail the whole export: silently exporting without that table
    // produces a backup the import then treats as authoritative, DELETing the table's existing rows.
    const query = jest.fn((sql: string) =>
      sql === 'SELECT * FROM messages'
        ? Promise.reject(new Error('SQLITE_BUSY: database is locked'))
        : Promise.resolve([]),
    );
    await expect(build(query).exportData()).rejects.toThrow(/database is locked/);
  });

  it('tolerates a genuinely absent optional table — and marks it in skippedTables', async () => {
    const missing = Object.assign(new Error('no such table: messages'), { name: 'SqliteError' });
    const query = jest.fn((sql: string) =>
      sql === 'SELECT * FROM messages' ? Promise.reject(missing) : Promise.resolve([]),
    );
    const dump = await build(query).exportData();
    expect(dump.counts.messages).toBe(0);
    expect(dump.tables.messages).toEqual([]);
    expect(dump.skippedTables).toContain('messages');
    // Every other table still exported (all empty here, none skipped).
    expect(dump.skippedTables).toEqual(['messages']);
  });

  it('strips the Postgres generated body_ts tsvector from exported message rows', async () => {
    // Postgres' STORED generated FTS column rides along in `SELECT *`; it is an index artifact, not
    // payload, and must not be serialized into a (dialect-neutral) backup.
    const messageRow = {
      id: 'm1',
      sessionId: 's1',
      waMessageId: 'WA1',
      chatId: 'c1',
      chatName: null,
      author: null,
      from: 'a',
      to: 'b',
      body: 'hello',
      type: 'text',
      direction: 'incoming',
      timestamp: 1700000000,
      metadata: null,
      status: 'delivered',
      createdAt: '2026-01-01T00:00:00.000Z',
      body_ts: "'hello'",
    };
    const query = jest.fn((sql: string) => Promise.resolve(sql === 'SELECT * FROM messages' ? [messageRow] : []));
    const dump = await build(query).exportData();
    expect(dump.tables.messages).toHaveLength(1);
    expect(dump.tables.messages[0]).not.toHaveProperty('body_ts');
    expect(dump.tables.messages[0].body).toBe('hello');
  });
});

describe('InfraController.importData status_updates + runtime reconciliation', () => {
  let ds: DataSource;
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };

  // Positional constructor: (config, mainDs, dataDs, engineFactory, dockerService, cacheService,
  // storageService, shutdownService, webhookQueue?, auditService?, sessionService?, lidMappingStore?).
  const build = (opts: { sessionService?: unknown; lidMappingStore?: unknown } = {}) =>
    new InfraController(
      cfg as never,
      {} as never,
      ds,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      undefined,
      opts.sessionService as never,
      opts.lidMappingStore as never,
    );

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
        StatusUpdate,
      ],
      synchronize: true,
    });
    await ds.initialize();
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

  it('exports and restores status_updates (the table the docs promise is covered)', async () => {
    await seedSession('s1');
    const statusRepo = ds.getRepository(StatusUpdate);
    await statusRepo.save(
      statusRepo.create({
        id: 'su1',
        sessionId: 's1',
        contactJid: '628111@c.us',
        contactName: 'Alice',
        contactPushName: 'alice',
        waStatusId: 'false_status@broadcast_ABC',
        type: 'text',
        caption: 'on vacation',
        mediaOmitted: true,
        omitReason: 'over_cap',
        backgroundColor: '#FF0000',
        font: 2,
        postedAt: 1750000000000,
        expiresAt: 1750086400000,
      }),
    );

    const controller = build();
    const dump = await controller.exportData();
    expect(dump.counts.statusUpdates).toBe(1);
    expect(dump.skippedTables).toEqual([]);

    await statusRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.statusUpdates).toBe(1);
    const restored = await statusRepo.findOneByOrFail({ id: 'su1' });
    expect(restored.waStatusId).toBe('false_status@broadcast_ABC');
    expect(restored.caption).toBe('on vacation');
    expect(restored.mediaOmitted).toBe(true); // boolean survives the 0/1 round-trip
    expect(restored.omitReason).toBe('over_cap');
    expect(restored.font).toBe(2);
    expect(restored.postedAt).toBe(1750000000000);
    expect(restored.expiresAt).toBe(1750086400000);
  });

  it('tolerates body_ts on imported message rows (backup made before the strip)', async () => {
    await seedSession('s1');
    const res = await build().importData({
      tables: {
        sessions: [
          {
            id: 's1',
            name: 'session-s1',
            status: 'ready',
            config: '{}',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ] as never,
        messages: [
          {
            id: 'm1',
            sessionId: 's1',
            waMessageId: 'WA1',
            chatId: 'c1',
            from: 'a',
            to: 'b',
            body: 'hello',
            type: 'text',
            direction: 'incoming',
            status: 'delivered',
            createdAt: '2026-01-01T00:00:00.000Z',
            body_ts: "'hello'", // legacy Postgres export artifact — must be ignored, not fail
          },
        ] as never,
      },
    });
    expect(res.imported).toBe(true);
    expect(res.warnings).toEqual([]);
    expect((await ds.getRepository(Message).findOneByOrFail({ id: 'm1' })).body).toBe('hello');
  });

  it('reloads the in-memory lid mappings after a committed restore', async () => {
    await seedSession('s1');
    const lidMappingStore = { reload: jest.fn().mockResolvedValue(undefined) };
    const controller = build({ lidMappingStore });
    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);
    expect(lidMappingStore.reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT reload lid mappings when the import is refused (nothing committed)', async () => {
    await seedSession('s1');
    const lidMappingStore = { reload: jest.fn().mockResolvedValue(undefined) };
    const res = await build({ lidMappingStore }).importData({ tables: {} });
    expect(res.imported).toBe(false);
    expect(lidMappingStore.reload).not.toHaveBeenCalled();
  });

  it('409s when a live engine would be orphaned by the replace — unless force=true', async () => {
    await seedSession('s1');
    const controller = build({ sessionService: { getActiveSessionIds: () => ['ghost'] } });
    const dump = await controller.exportData(); // backup contains only s1, not the running 'ghost'

    // Without force: 409 Conflict, and the destructive replace never started.
    const err = await controller.importData({ tables: dump.tables }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).message).toContain('ghost');
    expect(await ds.getRepository(Session).count()).toBe(1); // nothing deleted

    // With force: the restore proceeds and the response tells the operator a restart is required
    // to stop the orphaned engine.
    const res = await controller.importData({ tables: dump.tables, force: true });
    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(true);
    expect(res.orphanedEngines).toEqual(['ghost']);
  });

  it('reports restartRequired:false when no live engine is orphaned', async () => {
    await seedSession('s1');
    const controller = build({ sessionService: { getActiveSessionIds: () => ['s1'] } });
    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(false);
    expect(res.orphanedEngines).toEqual([]);
  });

  it('stopOrphans=true stops the orphan engines inside the request and keeps restartRequired:false', async () => {
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['ghost'], notRunning: [], failed: [] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['ghost'], stopOrphanEngines },
    });
    const dump = await controller.exportData(); // backup contains only s1, not 'ghost'

    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });

    // The orphan engines were stopped (called once with exactly the orphan ids) and the import
    // proceeded without requiring a restart — the whole point of stopOrphans vs force.
    expect(stopOrphanEngines).toHaveBeenCalledWith(['ghost']);
    expect(stopOrphanEngines).toHaveBeenCalledTimes(1);
    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(false);
    expect(res.stoppedOrphanEngines).toEqual(['ghost']);
    expect(res.failedOrphanEngines).toEqual([]);
    expect(res.orphanedEngines).toEqual(['ghost']);
  });

  it('still reports the engines it already stopped when the import rolls back', async () => {
    // The pre-flight teardown runs BEFORE the transaction opens and cannot be rolled back with it.
    // An operator reading imported:false plus empty orphan arrays would conclude nothing happened,
    // while their sessions are actually down.
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['ghost'], notRunning: [], failed: [] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['ghost'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    // A message row missing the non-null from/to fails mid-import and forces the all-or-nothing rollback.
    const res = await controller.importData({
      tables: {
        ...dump.tables,
        messages: [
          { id: 'mX', sessionId: 's1', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ] as never,
      },
      stopOrphans: true,
    });

    expect(res.imported).toBe(false); // the DB really did roll back
    expect(stopOrphanEngines).toHaveBeenCalledWith(['ghost']); // ...but the teardown really did happen
    expect(res.stoppedOrphanEngines).toEqual(['ghost']);
    expect(res.orphanedEngines).toEqual(['ghost']);
    expect(res.restartRequired).toBe(false); // sessions survive the rollback; restart them via the API
  });

  it('flags restartRequired on a rolled-back import whose orphan teardown failed', async () => {
    // The failed teardown is the one irreversible thing a rollback cannot undo: the Chromium/socket
    // may still be alive, so this must stay true even though no data changed.
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: [], notRunning: [], failed: ['ghost'] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['ghost'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    const res = await controller.importData({
      tables: {
        ...dump.tables,
        messages: [
          { id: 'mX', sessionId: 's1', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ] as never,
      },
      stopOrphans: true,
    });

    expect(res.imported).toBe(false);
    expect(res.restartRequired).toBe(true);
    expect(res.failedOrphanEngines).toEqual(['ghost']);
  });

  it('stopOrphans=true surfaces a teardown failure as restartRequired:true + a warning (Map reconciled regardless)', async () => {
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['g1'], notRunning: [], failed: ['g2'] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['g1', 'g2'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });

    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(true);
    expect(res.failedOrphanEngines).toEqual(['g2']);
    expect(res.stoppedOrphanEngines).toEqual(['g1']);
    expect(res.notices.some(w => w.includes('g2') && w.includes('restart'))).toBe(true);
  });

  it('stopOrphans=true reports notRunning orphans (still initializing) as a warning', async () => {
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['g1'], notRunning: ['g-init'], failed: [] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['g1', 'g-init'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });

    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(false);
    expect(res.notices.some(w => w.includes('g-init') && w.includes('initializing'))).toBe(true);
  });

  it('stopOrphans=true is a no-op when there is no sessionService wired', async () => {
    // Some stripped-down module shapes may not import SessionModule; the controller must not throw
    // when stopOrphans is requested but the service is unavailable — it falls back to refuse/force.
    await seedSession('s1');
    const controller = build({}); // no sessionService
    const dump = await controller.exportData();

    // Without sessionService there are no active ids to detect, so no orphan, no 409 — the import
    // proceeds normally. (This matches the @Optional() wiring; the gate only engages when the
    // service is present.)
    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });
    expect(res.imported).toBe(true);
    expect(res.stoppedOrphanEngines).toEqual([]);
  });
});

describe('InfraController storage stream failures surface as request errors, not process crashes', () => {
  it('importStorage maps an archive/stream failure to a 400 with the real reason', async () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/bad.tar.gz');
    try {
      const storage = {
        importFromStream: jest.fn().mockRejectedValue(new Error('incorrect header check')),
        getCurrentStorageType: () => 'local',
      };
      const controller = new InfraController(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        storage as never,
        {} as never,
      );
      const err = await controller.importStorage({ filePath: 'data/exports/bad.tar.gz' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('incorrect header check');
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });

  it('exportStorage rejects (and the process lives) when the export source stream errors', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-err-'));
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      // pipe() never forwards source errors: without a listener on the source this would be an
      // unhandled 'error' event and kill the process instead of failing the request.
      const errStream = new Readable({
        read() {
          this.destroy(new Error('archive boom'));
        },
      });
      const storage = { createExportStream: jest.fn().mockResolvedValue(errStream) };
      const controller = new InfraController(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        storage as never,
        {} as never,
      );
      await expect(controller.exportStorage()).rejects.toThrow(/archive boom/);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
