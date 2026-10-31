import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
  };
});

// The save guard probes the storage root the way the boot does, which creates the directory. Keep a save
// in a test from making one in the working tree; the cases that need the real probe ask for it.
jest.mock('../../config/storage-root', () => {
  const actual = jest.requireActual<typeof import('../../config/storage-root')>('../../config/storage-root');
  return { ...actual, resolveStorageRoot: jest.fn((options: { configured?: string }) => options.configured ?? '') };
});

import type { Server } from 'http';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import request from 'supertest';
import { InfraConfigController } from './infra-config.controller';
import { applyGlobalValidation } from '../../config/app-validation';
import { ShutdownService } from '../../common/services/shutdown.service';
import { EngineFactory } from '../../engine/engine.factory';
import { DockerService } from '../docker';
import { SaveConfigDto } from './dto/save-config.dto';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { recordOsEnvKeys, recordPinnedEnvKeys } from '../../config/env-precedence';
import { resolveStorageRoot } from '../../config/storage-root';
import { validateEnv } from '../../config/env.validation';
import { redisConnectionOptions } from '../../config/redis-options';
import {
  EXPECTED_MODE,
  EXPECTED_MODE_FLAG_PINNED,
  FILE_STATES,
  HOST_SPELLINGS,
  PIN_STATES,
  SERVICES,
  SERVICE_NAMES,
  fileLines,
  pinnedHost,
  type FileState,
  type PinState,
  type SavedMode,
  type ServiceName,
} from '../../../test/fixtures/builtin-mode-cases';

// With no boot snapshot every process.env key counts as host-supplied, so a shell exporting the
// CI Postgres or compose Redis settings would otherwise feed the save guard and the pin checks.
// Scrub the infrastructure keys for the whole file; tests that need a host value set it themselves.
const HOST_ENV = Object.keys(process.env).filter(k =>
  /^(DATABASE_|POSTGRES_|REDIS_|STORAGE_|S3_|MINIO_|QUEUE_|PUPPETEER_|ENGINE_TYPE$|SESSION_DATA_PATH$)/.test(k),
);
const hostEnvSaved = HOST_ENV.map(k => [k, process.env[k]] as const);
beforeAll(() => HOST_ENV.forEach(k => delete process.env[k]));
afterAll(() => hostEnvSaved.forEach(([k, v]) => (process.env[k] = v)));

// These helpers exercise individual settings on an otherwise complete PostgreSQL configuration.
function completeDatabaseFixture(config: unknown, existing = ''): SaveConfigDto {
  const payload = config as SaveConfigDto;
  if (payload.database?.type !== 'postgres' || payload.database.builtIn === true) return payload;
  const saved = jest.requireActual<typeof import('dotenv')>('dotenv').parse(existing);
  return {
    ...payload,
    database: {
      ...(!saved.DATABASE_HOST && !process.env.DATABASE_HOST ? { host: 'localhost' } : {}),
      ...(!saved.DATABASE_USERNAME && !process.env.DATABASE_USERNAME ? { username: 'postgres' } : {}),
      ...payload.database,
    },
  };
}

describe('InfraConfigController.saveConfig SSL reject-unauthorized', () => {
  function writtenEnv(config: unknown): string {
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const controller = new InfraConfigController({} as never, {} as never, {} as never);
    controller.saveConfig(completeDatabaseFixture(config));
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

  // The bundled PostgreSQL container runs without TLS, so the built-in database connects without it: SSL carried
  // over from an external server would refuse every connection of the next boot.
  describe('with the built-in database', () => {
    const EXTERNAL_TLS =
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.ext.example\nDATABASE_PASSWORD=ExtPw12345!\n' +
      'DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n';
    const parsed = (text: string) => jest.requireActual<typeof import('dotenv')>('dotenv').parse(text);
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(EXTERNAL_TLS);
    });
    afterEach(() => {
      delete process.env.DATABASE_HOST;
      delete process.env.DATABASE_PASSWORD;
      recordPinnedEnvKeys({});
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
    });

    it('writes DATABASE_SSL=false and drops the verify setting over a file with SSL on', () => {
      const env = parsed(
        writtenEnv({
          database: { type: 'postgres', builtIn: true, sslEnabled: true, sslRejectUnauthorized: false },
        }),
      );
      expect([env.DATABASE_HOST, env.DATABASE_SSL, env.DATABASE_SSL_REJECT_UNAUTHORIZED]).toEqual([
        'postgres',
        'false',
        undefined,
      ]);
    });

    it('writes it for a stored built-in database the section keeps without a flag', () => {
      (fs.readFileSync as jest.Mock).mockReturnValue(
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_SSL=true\n',
      );
      const env = parsed(writtenEnv({ database: { type: 'postgres', sslEnabled: true } }));
      expect([env.DATABASE_SSL, env.DATABASE_SSL_REJECT_UNAUTHORIZED]).toEqual(['false', undefined]);
    });

    it('keeps the setting sent beside a host pinned elsewhere, which the next boot dials', () => {
      process.env.DATABASE_HOST = 'db.ext.example';
      process.env.DATABASE_PASSWORD = 'PinnedPw456!';
      recordPinnedEnvKeys({ DATABASE_HOST: 'db.ext.example', DATABASE_PASSWORD: 'PinnedPw456!' });
      const env = parsed(
        writtenEnv({
          database: { type: 'postgres', builtIn: true, sslEnabled: true, sslRejectUnauthorized: false },
        }),
      );
      expect([env.DATABASE_SSL, env.DATABASE_SSL_REJECT_UNAUTHORIZED]).toEqual(['true', 'false']);
    });
  });
});

// The saved file is loaded by the next boot, whose validation refuses these values and crash-loops the
// instance, with the dashboard that could undo the save down.
describe('InfraConfigController.saveConfig values the next boot refuses', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);
  const external = { type: 'postgres', builtIn: false, host: 'db', username: 'u', password: 'unit-test-pw' };

  it.each([
    ['a database port that is not a number', { database: { ...external, port: 'abc' } }],
    ['a database port above 65535', { database: { ...external, port: '99999' } }],
    ['a database port of zero', { database: { ...external, port: '0' } }],
    ['a negative pool size', { database: { ...external, poolSize: -5 } }],
    ['a fractional pool size', { database: { ...external, poolSize: 1.5 } }],
    ['a redis port that is not a number', { redis: { enabled: true, host: 'cache', port: 'x' } }],
    [
      'an S3 endpoint without a scheme',
      {
        storage: {
          type: 's3',
          builtIn: false,
          s3Endpoint: 'minio:9000',
          s3AccessKey: 'AccessKey1234',
          s3SecretKey: 'SecretKey1234567',
        },
      },
    ],
  ])('refuses %s instead of writing it', (_label, config) => {
    (fs.writeFileSync as jest.Mock).mockClear();

    expect(() => newController().saveConfig(config as never)).toThrow(BadRequestException);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  // The boot only reports an S3 endpoint the client cannot use, so an instance that stored one keeps starting, and the
  // dashboard, which sends the storage type and endpoint with every save, must keep saving. The endpoint is refused
  // only when the save changes what the boot reads for it or newly selects S3.
  describe('an S3 endpoint without a scheme', () => {
    const KEYS = 'S3_ACCESS_KEY_ID=AccessKey1234\nS3_SECRET_ACCESS_KEY=SecretKey1234567\n';
    const S3_STORED = `STORAGE_TYPE=s3\nS3_ENDPOINT=minio:9000\n${KEYS}`;
    const NEW_KEYS = { s3AccessKey: 'AccessKey1234', s3SecretKey: 'SecretKey1234567' };
    const LOCAL_STORED = `STORAGE_TYPE=local\nS3_ENDPOINT=minio:9000\n${KEYS}`;
    const store = (text: string) => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(text);
      (fs.writeFileSync as jest.Mock).mockClear();
    };
    // What the dashboard sends after a reload: the storage section is always present, with the stored endpoint.
    const dashboardSave = (storage: object) =>
      ({
        engine: { headless: false },
        storage: { type: 's3', s3Bucket: 'media', s3Endpoint: 'minio:9000', ...storage },
      }) as never;
    afterEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      delete process.env.S3_ENDPOINT;
      delete process.env.STORAGE_TYPE;
      recordPinnedEnvKeys({});
    });

    it('does not stop a save of another section', () => {
      store(S3_STORED);
      expect(newController().saveConfig({ engine: { headless: false } }).saved).toBe(true);
    });

    it('does not stop a dashboard save that resubmits the stored endpoint', () => {
      store(S3_STORED);
      expect(newController().saveConfig(dashboardSave({})).saved).toBe(true);
    });

    it('refuses a save that changes it to another unusable value, with the boot text', () => {
      store(S3_STORED);
      expect(() => newController().saveConfig(dashboardSave({ s3Endpoint: 'other:9000' }))).toThrow(
        /fails boot validation\. S3_ENDPOINT must be an absolute http\(s\) URL/,
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('refuses a save that newly selects S3 beside it', () => {
      store(LOCAL_STORED);
      expect(() =>
        newController().saveConfig({ storage: { type: 's3', s3Endpoint: 'minio:9000', ...NEW_KEYS } } as never),
      ).toThrow(/S3_ENDPOINT must be an absolute http\(s\) URL/);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('refuses newly selecting S3 while the environment pins it', () => {
      store(LOCAL_STORED);
      process.env.S3_ENDPOINT = 'minio:9000';
      recordPinnedEnvKeys({ S3_ENDPOINT: 'minio:9000' });
      expect(() => newController().saveConfig({ storage: { type: 's3', ...NEW_KEYS } } as never)).toThrow(
        /S3_ENDPOINT must be an absolute http\(s\) URL/,
      );
    });

    it('saves a switch to local storage', () => {
      store(S3_STORED);
      expect(newController().saveConfig({ storage: { type: 'local', localPath: './data/media' } } as never).saved).toBe(
        true,
      );
    });

    it('accepts the endpoint once it carries the scheme', () => {
      store(S3_STORED);
      expect(newController().saveConfig(dashboardSave({ s3Endpoint: 'http://minio:9000' })).saved).toBe(true);
    });

    it('does not block a save while the environment pins it, which the page cannot change', () => {
      store(S3_STORED);
      Object.assign(process.env, { S3_ENDPOINT: 'minio:9000', STORAGE_TYPE: 's3' });
      recordPinnedEnvKeys({ S3_ENDPOINT: 'minio:9000', STORAGE_TYPE: 's3' });
      expect(newController().saveConfig(dashboardSave({})).saved).toBe(true);
      expect(newController().saveConfig(dashboardSave({ s3Endpoint: 'http://minio:9000' })).saved).toBe(true);
    });
  });

  it('writes a blank host and user as the defaults and trims a padded port', () => {
    (fs.writeFileSync as jest.Mock).mockClear();

    newController().saveConfig({
      database: {
        type: 'postgres',
        builtIn: false,
        host: '   ',
        port: ' 5433 ',
        username: '  ',
        password: 'unit-test-pw',
      },
    } as never);

    const content = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
    expect(content).toContain('DATABASE_HOST=localhost');
    expect(content).toContain('DATABASE_PORT=5433');
    expect(content).toContain('DATABASE_USERNAME=postgres');
  });
});

// The next boot refuses to start on a media root the app cannot create or write, before Nest builds, and
// the dashboard that could undo the save is down with it.
describe('InfraConfigController.saveConfig local storage path', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);
  const actual = jest.requireActual<typeof import('../../config/storage-root')>('../../config/storage-root');
  const useRealProbe = () => (resolveStorageRoot as jest.Mock).mockImplementationOnce(actual.resolveStorageRoot);
  // A parent that is a file, so the directory cannot be created whoever runs the test.
  const unwritable = '/dev/null/openwa-media';
  const localAt = (localPath: string) => ({ storage: { type: 'local', localPath } }) as never;

  beforeEach(() => {
    (fs.writeFileSync as jest.Mock).mockClear();
    (resolveStorageRoot as jest.Mock).mockClear();
  });

  it('refuses a path the app cannot create, and writes nothing', () => {
    useRealProbe();

    expect(() => newController().saveConfig(localAt(unwritable))).toThrow(BadRequestException);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('names the submitted path, not where it resolves to', () => {
    // Relative, under a regular file (this one), so its absolute form carries the working directory.
    const relative = path.relative(process.cwd(), path.join(__filename, 'media'));
    useRealProbe();

    let message = '';
    try {
      newController().saveConfig(localAt(relative));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`storage path '${relative}'`);
    expect(message).not.toContain(process.cwd());
  });

  it('saves a path the app can write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-storage-'));
    try {
      useRealProbe();

      newController().saveConfig(localAt(path.join(root, 'media')));

      const content = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
      expect(content).toContain(`STORAGE_LOCAL_PATH=${path.join(root, 'media')}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not judge a path that a value pinned by the host outranks', () => {
    // With no boot snapshot recorded, every key in the environment counts as host-supplied.
    process.env.STORAGE_LOCAL_PATH = '/srv/openwa/media';
    try {
      newController().saveConfig(localAt(unwritable));

      expect(resolveStorageRoot).not.toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.STORAGE_LOCAL_PATH;
    }
  });

  it('leaves a save that names no path alone', () => {
    newController().saveConfig({ queue: { enabled: false } });

    expect(resolveStorageRoot).not.toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('InfraConfigController PostgreSQL schema (POSTGRES_SCHEMA)', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(completeDatabaseFixture(config, existing));
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

  it('refuses a schema the next boot would reject instead of writing it', () => {
    (fs.writeFileSync as jest.Mock).mockClear();
    for (const schema of ['OpenWA', 'pg_data', 'bad-name']) {
      expect(() =>
        newController().saveConfig({
          database: { type: 'postgres', builtIn: false, host: 'db', schema, password: 'unit-test-pw' },
        } as never),
      ).toThrow(BadRequestException);
    }
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('still writes the public default for an empty schema', () => {
    const env = written({
      database: { type: 'postgres', builtIn: false, host: 'db', schema: '', password: 'unit-test-pw' },
    });
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

describe('InfraConfigController.saveConfig writes the generated env owner-only', () => {
  // data/.env.generated holds DB/S3/Redis credentials, so it must be written 0600 — not the
  // default 0644 (world-readable). The write must go through the same owner-only path the
  // first-run boot uses, closing the gap between a dashboard save and the next restart.
  it('persists data/.env.generated with mode 0600, not world-readable', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const controller = new InfraConfigController({} as never, {} as never, {} as never);
    controller.saveConfig({
      database: { type: 'postgres', host: 'db', username: 'app', sslEnabled: true, password: 'pw' },
    } as never);
    const opts = writeSpy.mock.calls[0][2];
    expect(opts).toEqual({ mode: 0o600 });
    writeSpy.mockRestore();
  });
});

describe('InfraConfigController.saveConfig env-name correctness and merge (#226)', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(completeDatabaseFixture(config, existing));
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
    const env = written(
      { database: { type: 'postgres', host: 'db', password: '' } },
      'DATABASE_TYPE=postgres\nDATABASE_PASSWORD=keepme\n',
    );
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

describe('InfraConfigController.saveConfig rejects values that would inject extra env vars', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

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

describe('InfraConfigController.saveConfig writes values the next boot reads back unchanged', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

  function savedPassword(password: string): { line: string | undefined; parsed: string | undefined } {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig({
      database: { type: 'postgres', builtIn: false, host: 'db', username: 'app', password },
    } as never);
    const content = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
    return {
      line: content.split('\n').find(l => l.startsWith('DATABASE_PASSWORD=')),
      parsed: jest.requireActual<typeof import('dotenv')>('dotenv').parse(content).DATABASE_PASSWORD,
    };
  }

  // dotenv reads an unquoted `#` as a comment and trims outer quotes and whitespace, so a raw
  // `KEY=value` line would boot with a different secret than the one saved.
  it.each(['S3cr#tPass', ' spaced ', "'quoted'", '"dq"', 'p\\nq', `it's#`, `a'b"c#`])(
    'round-trips %j through dotenv',
    password => {
      expect(savedPassword(password).parsed).toBe(password);
    },
  );

  it('keeps a value that needs no quoting bare', () => {
    expect(savedPassword('Str0ng!Passw0rd').line).toBe('DATABASE_PASSWORD=Str0ng!Passw0rd');
  });

  // Each line reads back on its own, but the next boot parses the whole file, where a quote one value
  // leaves open can run on to a later line that holds the same quote character.
  function savedFile(databasePassword: string, redisPassword: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig({
      database: { type: 'postgres', builtIn: false, host: 'db', username: 'app', password: databasePassword },
      redis: { enabled: true, builtIn: false, host: 'cache', password: redisPassword },
    } as never);
    return ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
  }

  it('keeps every key intact when a value opens a quote that a later line closes', () => {
    const dotenv = jest.requireActual<typeof import('dotenv')>('dotenv');
    const content = savedFile('"x7Kp', 'ab"#cd');
    const whole = dotenv.parse(content);
    const lineByLine = Object.assign({}, ...content.split('\n').map(line => dotenv.parse(line))) as Record<
      string,
      string
    >;

    expect(whole).toEqual(lineByLine);
    expect(whole).toMatchObject({ DATABASE_TYPE: 'postgres', DATABASE_PASSWORD: '"x7Kp', REDIS_PASSWORD: 'ab"#cd' });
  });

  it('refuses a quoted value that a later line would extend, writing nothing', () => {
    // `#x\` needs quoting, and its `\'` escapes the closing quote once a later line holds a `'#`.
    expect(() => savedFile('#x\\', `a'#b`)).toThrow(/DATABASE_PASSWORD/);
    expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
  });

  it('refuses a value no dotenv form can carry, writing nothing', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.writeFileSync as jest.Mock).mockClear();
    expect(() =>
      newController().saveConfig({
        database: { type: 'postgres', builtIn: false, host: 'db', password: `a'b"c\`d#` },
      } as never),
    ).toThrow(BadRequestException);
    expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('InfraConfigController.saveConfig engine selection (persist ENGINE_TYPE — Infrastructure tile)', () => {
  const engineFactory = {
    getAvailableEngines: () => [{ id: 'whatsapp-web.js' }, { id: 'baileys' }],
  };
  const newController = () => new InfraConfigController(engineFactory as never, {} as never, {} as never);

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(completeDatabaseFixture(config, existing));
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

describe('InfraConfigController.saveConfig byte-identical regression (full dashboard payload)', () => {
  // Pins the legitimate behavior: a FULL dashboard save (every section, every field — the exact
  // shape Infrastructure.tsx posts) must produce exactly the same .env.generated bytes as before
  // the per-key merge change. The literal key maps below were derived from the previous
  // implementation's output; any drift in written keys or values fails this gate.
  const engineFactory = {
    getAvailableEngines: () => [{ id: 'whatsapp-web.js' }, { id: 'baileys' }],
  };
  const newController = () => new InfraConfigController(engineFactory as never, {} as never, {} as never);

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
        REDIS_TLS: 'false',
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

describe('InfraConfigController.saveConfig per-key merge (partial payloads)', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(completeDatabaseFixture(config, existing));
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

  it('an omitted builtIn follows the stored host beside stale true flags', () => {
    const existing =
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=db.ext.example\nDATABASE_USERNAME=app\n' +
      'DATABASE_PASSWORD=ExtPw12345!\nDATABASE_NAME=appdb\nPOSTGRES_SCHEMA=tenant\n' +
      'REDIS_ENABLED=true\nREDIS_BUILTIN=true\nREDIS_HOST=cache.ext.example\nREDIS_PORT=6380\nREDIS_PASSWORD=RedisPw123456\n' +
      'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=https://s3.ext.example\nS3_BUCKET=media\nS3_REGION=eu-west-1\n' +
      'S3_ACCESS_KEY_ID=ExternalKey12345\nS3_SECRET_ACCESS_KEY=ExternalSecret1234567890\n';
    const dotenv = jest.requireActual<typeof import('dotenv')>('dotenv');

    expect(
      dotenv.parse(
        written({ database: { poolSize: 25 }, redis: { port: '6381' }, storage: { s3Region: 'eu-west-2' } }, existing),
      ),
    ).toEqual({
      ...dotenv.parse(existing),
      DATABASE_POOL_SIZE: '25',
      REDIS_PORT: '6381',
      S3_REGION: 'eu-west-2',
    });
  });

  it('a true flag beside an external host does not give its credentials to a newly chosen bundled container', () => {
    const env = written(
      { database: { type: 'postgres', builtIn: true }, storage: { type: 's3', builtIn: true } },
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=db.ext.example\nDATABASE_PASSWORD=ExtPw12345!\n' +
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=https://s3.ext.example\nS3_ACCESS_KEY_ID=ExternalKey12345\n' +
        'S3_SECRET_ACCESS_KEY=ExternalSecret1234567890\n',
    );

    expect(env).toContain('DATABASE_PASSWORD=openwa');
    expect(env).toContain('S3_ACCESS_KEY_ID=minioadmin');
    expect(env).toContain('S3_SECRET_ACCESS_KEY=minioadmin');
  });

  it('a null pool size reads as absent and keeps the stored one', () => {
    const existing =
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=old.example.com\nDATABASE_PASSWORD=keepme\nDATABASE_POOL_SIZE=25\n';
    const env = written({ database: { type: 'postgres', poolSize: null } }, existing);
    expect(env).toContain('DATABASE_POOL_SIZE=25');
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

  // The page leaves out a type the environment pins while the operator has not touched it, so the pin is never
  // written over the stored choice. The section then applies to the stored selection, and never rewrites it.
  describe('a section without its type', () => {
    const STORED_EXTERNAL =
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.example.com\nDATABASE_USERNAME=app\n' +
      'DATABASE_PASSWORD=Str0ng!Passw0rd\nDATABASE_NAME=appdb\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
      'S3_ENDPOINT=https://s3.example.com\nS3_BUCKET=media\nS3_ACCESS_KEY_ID=ak-strong\nS3_SECRET_ACCESS_KEY=sk-strong\n';
    const STORED_LOCAL = 'DATABASE_TYPE=sqlite\nPOSTGRES_BUILTIN=false\nSTORAGE_TYPE=local\nMINIO_BUILTIN=false\n';
    let pinnedKeys: string[] = [];
    const pin = (values: Record<string, string>) => {
      Object.assign(process.env, values);
      pinnedKeys = Object.keys(values);
      recordPinnedEnvKeys(values);
    };

    afterEach(() => {
      for (const key of pinnedKeys) delete process.env[key];
      pinnedKeys = [];
      recordPinnedEnvKeys({});
    });

    // The page sends every field of a card, seeded with defaults for keys nothing stores. Applied to the stored
    // PostgreSQL while SQLite is pinned, that writes DATABASE_NAME=openwa, a bare name the pinned SQLite boot refuses.
    it('writes nothing of a section whose pinned selection differs from the stored one', () => {
      pin({ DATABASE_TYPE: 'sqlite', STORAGE_TYPE: 'local' });
      const stored = STORED_EXTERNAL.replace('DATABASE_NAME=appdb\n', '');

      const env = written(
        {
          database: { builtIn: false, host: 'db.example.com', port: '5432', database: 'openwa', poolSize: 10 },
          storage: { builtIn: false, localPath: './data/media', s3Region: 'ap-southeast-1' },
        },
        stored,
      );

      expect(env).not.toMatch(/^(DATABASE_NAME|DATABASE_PORT|DATABASE_POOL_SIZE|S3_REGION|STORAGE_LOCAL_PATH)=/m);
      for (const line of stored.trim().split('\n')) expect(env).toContain(line);
      const parsed = jest.requireActual<typeof import('dotenv')>('dotenv').parse(env);
      expect(() => validateEnv({ ...parsed, DATABASE_TYPE: 'sqlite', STORAGE_TYPE: 'local' })).not.toThrow();
    });

    it('keeps a stored PostgreSQL and S3 choice and their settings under the opposite pins', () => {
      pin({ DATABASE_TYPE: 'sqlite', DATABASE_NAME: './data/pinned.sqlite', STORAGE_TYPE: 'local' });

      const env = written(
        {
          database: { builtIn: false, host: 'db.example.com', username: 'app', database: 'appdb' },
          storage: {
            builtIn: false,
            localPath: './data/media',
            s3Bucket: 'media',
            s3Endpoint: 'https://s3.example.com',
          },
        },
        STORED_EXTERNAL,
      );

      for (const line of STORED_EXTERNAL.trim().split('\n')) expect(env).toContain(line);
      expect(env).not.toMatch(/^STORAGE_LOCAL_PATH=/m);
    });

    it('keeps a stored SQLite and local choice under the opposite pins, with no bundled container', () => {
      pin({
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'db.pinned.example',
        DATABASE_USERNAME: 'app',
        DATABASE_PASSWORD: 'Str0ng!Passw0rd',
        STORAGE_TYPE: 's3',
        S3_ACCESS_KEY_ID: 'ak-strong',
        S3_SECRET_ACCESS_KEY: 'sk-strong',
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(STORED_LOCAL);

      const { profiles } = newController().saveConfig({
        database: { builtIn: true, host: 'postgres' },
        storage: { builtIn: true, s3Endpoint: 'http://minio:9000' },
      });
      const env = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>).at(-1)![1];

      for (const line of STORED_LOCAL.trim().split('\n')) expect(env).toContain(line);
      expect(env).not.toMatch(/^(DATABASE_HOST|S3_ENDPOINT)=/m);
      expect(profiles).toEqual([]);
    });

    it('follows a pinned type without writing it when nothing is stored', () => {
      pin({
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'db.pinned.example',
        DATABASE_USERNAME: 'app',
        DATABASE_PASSWORD: 'Str0ng!Passw0rd',
        STORAGE_TYPE: 's3',
        S3_ACCESS_KEY_ID: 'ak-strong',
        S3_SECRET_ACCESS_KEY: 'sk-strong',
      });

      const env = written(
        { database: { builtIn: false, host: 'db.example.com' }, storage: { builtIn: false, s3Bucket: 'media' } },
        'POSTGRES_BUILTIN=false\nSTORAGE_LOCAL_PATH=./data/media\n',
      );

      expect(env).toContain('DATABASE_HOST=db.example.com');
      expect(env).toContain('S3_BUCKET=media');
      expect(env).not.toMatch(/^(DATABASE_TYPE|STORAGE_TYPE|STORAGE_LOCAL_PATH)=/m);
    });

    it.each([
      ['database', { database: { host: 'db.example.com' } }, /database\.type must be one of/],
      ['storage', { storage: { s3Bucket: 'media' } }, /storage\.type must be one of/],
    ])('is refused when no %s type is sent, stored or pinned', (_section, config, message) => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('DATABASE_TYPE=mysql\nSTORAGE_TYPE=ftp\n');
      (fs.writeFileSync as jest.Mock).mockClear();

      expect(() => newController().saveConfig(config as never)).toThrow(BadRequestException);
      expect(() => newController().saveConfig(config as never)).toThrow(message);
      expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
    });

    it('applies a section whose pinned selection is the stored one', () => {
      pin({ DATABASE_TYPE: 'postgres', STORAGE_TYPE: 's3' });

      const env = written({ database: { poolSize: 25 }, storage: { s3Bucket: 'media-2' } }, STORED_EXTERNAL);

      expect(env).toContain('DATABASE_POOL_SIZE=25');
      expect(env).toContain('S3_BUCKET=media-2');
    });

    it('applies a section to the stored selection when nothing pins one', () => {
      const env = written(
        { database: { host: 'db.example.com' }, storage: { localPath: './data/media-2' } },
        'DATABASE_TYPE=sqlite\nPOSTGRES_BUILTIN=false\nSTORAGE_TYPE=local\nSTORAGE_LOCAL_PATH=./data/media\n',
      );

      expect(env).toContain('STORAGE_LOCAL_PATH=./data/media-2');
      expect(env).not.toMatch(/^DATABASE_HOST=/m);
    });

    // The page also leaves the flag out of an untouched Redis or storage card beside a host pinned elsewhere, and sends
    // the host fields seeded with the pinned value. A stored built-in mode keeps its bundled host then, as the database
    // does: the pinned host beside a stored flag of true would start the container and switch back once it is lifted.
    it('keeps a stored built-in Redis and MinIO when the flag is left out beside hosts pinned elsewhere', () => {
      pin({
        REDIS_HOST: 'cache.ext.example',
        S3_ENDPOINT: 'https://s3.ext.example',
        S3_ACCESS_KEY_ID: 'ak-strong',
        S3_SECRET_ACCESS_KEY: 'sk-strong',
      });

      const env = written(
        {
          redis: { enabled: true, host: 'cache.ext.example', port: '6379' },
          queue: { enabled: false },
          storage: { type: 's3', s3Bucket: 'openwa', s3Endpoint: 'https://s3.ext.example' },
        },
        'REDIS_ENABLED=true\nREDIS_BUILTIN=true\nREDIS_HOST=redis\nREDIS_PORT=6379\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=true\n' +
          'S3_ENDPOINT=http://minio:9000\nS3_BUCKET=openwa\nS3_ACCESS_KEY_ID=minioadmin\nS3_SECRET_ACCESS_KEY=minioadmin\n',
      );

      for (const line of [
        'REDIS_BUILTIN=true',
        'REDIS_HOST=redis',
        'MINIO_BUILTIN=true',
        'S3_ENDPOINT=http://minio:9000',
      ]) {
        expect(env).toContain(line);
      }
    });

    it('keeps the details of a stored bundled host without a true flag while another host is pinned', () => {
      pin({ DATABASE_HOST: 'db.ext.example', S3_ENDPOINT: 'https://s3.ext.example' });
      const stored = STORED_EXTERNAL.replace('db.example.com', 'openwa-postgres').replace(
        'https://s3.example.com',
        'http://openwa-minio:9000',
      );
      const dotenv = jest.requireActual<typeof import('dotenv')>('dotenv');

      expect(dotenv.parse(written({ database: { poolSize: 25 }, storage: {} }, stored))).toEqual({
        ...dotenv.parse(stored),
        DATABASE_POOL_SIZE: '25',
      });
    });

    it('an inherited bundled mode does not reuse details from stored SQLite or local storage', () => {
      pin({ DATABASE_HOST: 'postgres', S3_ENDPOINT: 'http://minio:9000' });
      const env = written(
        { database: { type: 'postgres' }, storage: { type: 's3' } },
        'DATABASE_TYPE=sqlite\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_USERNAME=stale\n' +
          'DATABASE_NAME=./data/openwa.sqlite\nPOSTGRES_SCHEMA=stale\nSTORAGE_TYPE=local\nMINIO_BUILTIN=true\n' +
          'S3_ENDPOINT=http://minio:9000\nS3_BUCKET=stale\nS3_REGION=stale\n',
      );

      for (const line of [
        'DATABASE_USERNAME=openwa',
        'DATABASE_NAME=openwa',
        'POSTGRES_SCHEMA=public',
        'S3_BUCKET=openwa',
        'S3_REGION=us-east-1',
      ]) {
        expect(env).toContain(line);
      }
      expect(env).not.toContain('stale');
      expect(env).not.toContain('openwa.sqlite');
    });

    it.each(['true', 'false'])(
      'an omitted choice keeps connection details under external host pins beside flags %s',
      flag => {
        pin({
          DATABASE_HOST: 'db.ext.example',
          REDIS_HOST: 'cache.ext.example',
          S3_ENDPOINT: 'https://s3.ext.example',
        });
        const stored =
          `DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=${flag}\nDATABASE_HOST=postgres\nDATABASE_PORT=6432\n` +
          'DATABASE_USERNAME=app\nDATABASE_PASSWORD=StrongPw12345!\nDATABASE_NAME=appdb\nPOSTGRES_SCHEMA=tenant\nDATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n' +
          `REDIS_ENABLED=true\nREDIS_BUILTIN=${flag}\nREDIS_HOST=redis\nREDIS_PORT=6380\nREDIS_PASSWORD=CachePw123456\n` +
          `STORAGE_TYPE=s3\nMINIO_BUILTIN=${flag}\nS3_ENDPOINT=http://minio:9000\nS3_BUCKET=media\n` +
          'S3_ACCESS_KEY=StoredKey123456\nS3_SECRET_KEY=StoredSecret1234567890\n';
        const dotenv = jest.requireActual<typeof import('dotenv')>('dotenv');

        expect(dotenv.parse(written({ database: {}, redis: {}, storage: {} }, stored))).toEqual(dotenv.parse(stored));
        expect(
          dotenv.parse(
            written(
              {
                database: {
                  host: 'db.ext.example',
                  port: '5432',
                  username: 'pinned-user',
                  database: 'pinned-db',
                  schema: 'pinned_schema',
                },
                redis: { host: 'cache.ext.example', port: '6379' },
                storage: { s3Endpoint: 'https://s3.ext.example', s3Bucket: 'pinned-bucket', s3Region: 'pinned-region' },
              },
              stored,
            ),
          ),
        ).toEqual(dotenv.parse(stored));
        const explicit = dotenv.parse(
          written({ database: { builtIn: true }, redis: { builtIn: true }, storage: { builtIn: true } }, stored),
        );
        const expectedExplicit: Record<string, string> = {
          ...dotenv.parse(stored),
          POSTGRES_BUILTIN: 'true',
          REDIS_BUILTIN: 'true',
          MINIO_BUILTIN: 'true',
          DATABASE_PORT: '5432',
          DATABASE_USERNAME: 'openwa',
          DATABASE_NAME: 'openwa',
          POSTGRES_SCHEMA: 'public',
          REDIS_PORT: '6379',
          S3_BUCKET: 'openwa',
          S3_REGION: 'us-east-1',
          S3_ACCESS_KEY_ID: 'StoredKey123456',
          S3_SECRET_ACCESS_KEY: 'StoredSecret1234567890',
        };
        delete expectedExplicit.REDIS_PASSWORD;
        expect(explicit).toEqual(expectedExplicit);
        expect(dotenv.parse(written({ database: { poolSize: 25 }, redis: {}, storage: {} }, stored))).toEqual({
          ...dotenv.parse(stored),
          DATABASE_POOL_SIZE: '25',
        });
      },
    );

    // The page leaves out an untouched flag beside a pinned host. The stored external flag is inherited then, so the
    // credentials the pinned host may need stay as stored, where a flag of true would write the bundled ones.
    it('keeps stored external credentials when the flag is left out beside a pinned bundled host', () => {
      pin({ DATABASE_TYPE: 'postgres', DATABASE_HOST: 'postgres', S3_ENDPOINT: 'http://minio:9000' });
      const stored = STORED_EXTERNAL.replace('S3_ENDPOINT=https://s3.example.com\n', '') + 'POSTGRES_SCHEMA=custom\n';

      const env = written(
        {
          database: { host: 'postgres', username: 'app', database: 'appdb', schema: 'custom', password: '' },
          storage: { s3Bucket: 'media', s3Endpoint: 'http://minio:9000', s3AccessKey: '', s3SecretKey: '' },
        },
        stored,
      );

      for (const line of [
        'POSTGRES_BUILTIN=false',
        'DATABASE_USERNAME=app',
        'DATABASE_PASSWORD=Str0ng!Passw0rd',
        'DATABASE_NAME=appdb',
        'POSTGRES_SCHEMA=custom',
        'MINIO_BUILTIN=false',
        'S3_BUCKET=media',
        'S3_ACCESS_KEY_ID=ak-strong',
        'S3_SECRET_ACCESS_KEY=sk-strong',
      ]) {
        expect(env).toContain(line);
      }
    });

    // What the page sends after an edit in the database card beside a host pinned to another server, over a stored
    // built-in database: the flag the card shows (false) and the typed fields, which are written as that server's.
    describe('an edited external card beside a host pinned elsewhere over a stored built-in database', () => {
      const STORED_BUILTIN =
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_PORT=5432\n' +
        'DATABASE_USERNAME=openwa\nDATABASE_PASSWORD=openwa\nDATABASE_NAME=openwa\nPOSTGRES_SCHEMA=public\n';
      const EDITED = {
        database: {
          type: 'postgres' as const,
          builtIn: false,
          host: 'db.ext.example',
          port: '6543',
          username: 'app',
          password: '',
          database: 'appdb',
          schema: 'tenant',
        },
      };

      it('writes the typed fields and resets the flag when the pinned password passes the guard', () => {
        pin({ DATABASE_HOST: 'db.ext.example', DATABASE_PASSWORD: 'PinnedPw456!' });
        const controller = newController();
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(STORED_BUILTIN);
        (fs.writeFileSync as jest.Mock).mockClear();

        const { profiles } = controller.saveConfig(EDITED);
        const env = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];

        for (const line of [
          'POSTGRES_BUILTIN=false',
          'DATABASE_HOST=db.ext.example',
          'DATABASE_PORT=6543',
          'DATABASE_USERNAME=app',
          'DATABASE_NAME=appdb',
          'POSTGRES_SCHEMA=tenant',
        ]) {
          expect(env).toContain(line);
        }
        expect(profiles).toEqual([]);
      });

      it('is refused while the external server would boot with no password', () => {
        pin({ DATABASE_HOST: 'db.ext.example' });

        expect(() => written(EDITED, STORED_BUILTIN)).toThrow(/DATABASE_PASSWORD/);
      });
    });

    it('still writes a type that is sent', () => {
      pin({ DATABASE_TYPE: 'sqlite', STORAGE_TYPE: 'local' });

      const env = written({ database: { type: 'sqlite' }, storage: { type: 'local' } }, STORED_EXTERNAL);

      expect(env).toContain('DATABASE_TYPE=sqlite');
      expect(env).toContain('STORAGE_TYPE=local');
      expect(env).not.toMatch(/^DATABASE_HOST=/m);
    });
  });
});

describe('InfraConfigController.saveConfig built-in/external mode flips and the save-time secret guard', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

  function written(config: unknown, existing?: string): string {
    (fs.existsSync as jest.Mock).mockReturnValue(existing !== undefined);
    (fs.readFileSync as jest.Mock).mockReturnValue(existing ?? '');
    (fs.writeFileSync as jest.Mock).mockClear();
    newController().saveConfig(completeDatabaseFixture(config, existing));
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
      /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
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
      /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
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

  // The page sends the flag it shows, so switching Redis off still carries builtIn true. Nothing the next boot runs
  // dials a Redis that is off, so no bundled container may be started or kept for it.
  describe('a Redis nothing uses keeps no bundled container', () => {
    const BUILTIN_REDIS_ENV =
      'REDIS_ENABLED=true\nREDIS_BUILTIN=true\nREDIS_HOST=redis\nREDIS_PORT=6379\nQUEUE_ENABLED=true\n';
    const switchedOff = {
      redis: { enabled: false, builtIn: true, host: 'redis', port: '6379' },
      queue: { enabled: false },
    };

    afterEach(() => {
      delete process.env.REDIS_ENABLED;
      recordPinnedEnvKeys({});
    });

    it('switching Redis off clears the built-in flag and the bundled host', () => {
      const env = written(switchedOff, BUILTIN_REDIS_ENV);

      expect(env).toContain('REDIS_ENABLED=false');
      expect(env).toContain('REDIS_BUILTIN=false');
      expect(env).not.toMatch(/^REDIS_HOST=/m);
    });

    it('keeps an external host when Redis is switched off', () => {
      const env = written(
        { redis: { enabled: false, builtIn: false, host: 'cache.example.com' }, queue: { enabled: false } },
        'REDIS_ENABLED=true\nREDIS_BUILTIN=false\nREDIS_HOST=cache.example.com\n',
      );

      expect(env).toContain('REDIS_BUILTIN=false');
      expect(env).toContain('REDIS_HOST=cache.example.com');
    });

    // The restart keeps a container while the saved host reaches it in any spelling, so each one is dropped here.
    it.each(HOST_SPELLINGS.redis.reach)('drops a host %j that still reaches the bundled container', host => {
      const env = written(
        { redis: { enabled: false, builtIn: false, host }, queue: { enabled: false } },
        `REDIS_ENABLED=true\nREDIS_BUILTIN=false\nREDIS_HOST=${host}\n`,
      );

      expect(env).not.toMatch(/^REDIS_HOST=/m);
    });

    it('keeps the bundled Redis while the queue still uses it', () => {
      const env = written({ redis: { enabled: false, builtIn: true }, queue: { enabled: true } }, BUILTIN_REDIS_ENV);

      expect(env).toContain('REDIS_BUILTIN=true');
      expect(env).toContain('REDIS_HOST=redis');
    });

    it('keeps the bundled Redis while the environment pins REDIS_ENABLED on', () => {
      process.env.REDIS_ENABLED = 'true';
      recordPinnedEnvKeys({ REDIS_ENABLED: 'true' });

      const env = written(switchedOff, BUILTIN_REDIS_ENV);

      expect(env).toContain('REDIS_BUILTIN=true');
      expect(env).toContain('REDIS_HOST=redis');
    });

    // The stored choice is kept for the day the pin is removed: the file still uses Redis then.
    it('keeps a stored bundled Redis while the environment pins REDIS_ENABLED off', () => {
      process.env.REDIS_ENABLED = 'false';
      recordPinnedEnvKeys({ REDIS_ENABLED: 'false' });

      const env = written(
        { redis: { builtIn: true, host: 'redis', port: '6379' }, queue: { enabled: false } },
        BUILTIN_REDIS_ENV,
      );

      expect(env).toContain('REDIS_ENABLED=true');
      expect(env).toContain('REDIS_BUILTIN=true');
      expect(env).toContain('REDIS_HOST=redis');
    });

    it('asks for the redis profile only while something uses Redis', () => {
      const profilesOf = (config: unknown) => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(BUILTIN_REDIS_ENV);
        const { profiles } = newController().saveConfig(config as never);
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        (fs.readFileSync as jest.Mock).mockReturnValue('');
        return profiles;
      };

      expect(profilesOf(switchedOff)).toEqual([]);
      expect(profilesOf({ redis: { enabled: false, builtIn: true }, queue: { enabled: true } })).toEqual(['redis']);
      expect(profilesOf({ redis: { enabled: true, builtIn: true } })).toEqual(['redis']);
    });
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

  // The stored password belongs to the bundled container whenever the next boot already dials it with that password,
  // whatever the flag says: an older or hand-edited file names the bundled host without the flag, and a pinned host
  // outranks the file's.
  describe('built-in mode over a stored password the next boot already dials the bundled host with', () => {
    afterEach(() => {
      delete process.env.DATABASE_HOST;
      delete process.env.DATABASE_PASSWORD;
      recordPinnedEnvKeys({});
    });

    it('keeps it when the file names the bundled host without the flag', () => {
      const env = written(
        { database: { type: 'postgres', builtIn: true } },
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=postgres\nDATABASE_PASSWORD=CustomPw123!\nDATABASE_NAME=openwa\n',
      );
      expect(env).toContain('POSTGRES_BUILTIN=true');
      expect(env).toContain('DATABASE_PASSWORD=CustomPw123!');
    });

    it('keeps it when the environment pins the bundled host over another host in the file', () => {
      process.env.DATABASE_HOST = 'postgres';
      recordPinnedEnvKeys({ DATABASE_HOST: 'postgres' });
      const env = written(
        { database: { type: 'postgres', builtIn: true } },
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.old.example\nDATABASE_PASSWORD=CustomPw123!\n',
      );
      expect(env).toContain('DATABASE_PASSWORD=CustomPw123!');
    });

    // A stored built-in flag keeps it under any host: the save leaves what the next boot dials with as it was.
    it('keeps it beside a stored built-in flag when the environment pins another host', () => {
      process.env.DATABASE_HOST = 'db.example.com';
      recordPinnedEnvKeys({ DATABASE_HOST: 'db.example.com' });
      const env = written(
        { database: { type: 'postgres', builtIn: true } },
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_PASSWORD=CustomPw123!\n',
      );
      expect(env).toContain('DATABASE_PASSWORD=CustomPw123!');
    });

    // Removing the host pin restores the stored bundled host, so its own password must remain usable then.
    it('keeps it when the environment pins another host over the bundled host in the file', () => {
      process.env.DATABASE_HOST = 'db.example.com';
      process.env.DATABASE_PASSWORD = 'PinnedPw456!';
      recordPinnedEnvKeys({ DATABASE_HOST: 'db.example.com', DATABASE_PASSWORD: 'PinnedPw456!' });
      const env = written(
        { database: { type: 'postgres', builtIn: true } },
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=postgres\nDATABASE_PASSWORD=ExternalPw!\n',
      );
      expect(env).toContain('DATABASE_PASSWORD=ExternalPw!');
    });

    // Any spelling that reaches the bundled container is the bundled host, as for the restart's stop and start rules.
    const STORED = 'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_PASSWORD=CustomPw123!\n';
    it.each(HOST_SPELLINGS.database.reach)('keeps it under %j in the file or pinned', host => {
      expect(written({ database: { type: 'postgres', builtIn: true } }, `${STORED}DATABASE_HOST=${host}\n`)).toContain(
        'DATABASE_PASSWORD=CustomPw123!',
      );
      process.env.DATABASE_HOST = host;
      recordPinnedEnvKeys({ DATABASE_HOST: host });
      expect(
        written({ database: { type: 'postgres', builtIn: true } }, `${STORED}DATABASE_HOST=db.old.example\n`),
      ).toContain('DATABASE_PASSWORD=CustomPw123!');
    });
    it.each(HOST_SPELLINGS.database.elsewhere)('still resets it under %j in the file', host => {
      expect(written({ database: { type: 'postgres', builtIn: true } }, `${STORED}DATABASE_HOST=${host}\n`)).toContain(
        'DATABASE_PASSWORD=openwa',
      );
    });
  });

  // The bundled MinIO is created with the keys the next boot reads, like the database password above.
  describe('built-in storage over stored keys the next boot already dials the bundled endpoint with', () => {
    const KEYS = 'S3_ACCESS_KEY_ID=StoredKey12345\nS3_SECRET_ACCESS_KEY=StoredSecret1234567890\n';

    afterEach(() => {
      delete process.env.S3_ENDPOINT;
      recordPinnedEnvKeys({});
    });

    it('keeps them when the flag is already set', () => {
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=http://minio:9000\nS3_BUCKET=openwa\n' + KEYS,
      );
      expect(env).toContain('S3_ACCESS_KEY_ID=StoredKey12345');
      expect(env).toContain('S3_SECRET_ACCESS_KEY=StoredSecret1234567890');
    });

    it('keeps them when the file names the bundled endpoint without the flag', () => {
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=false\nS3_ENDPOINT=http://minio:9000\nS3_BUCKET=openwa\n' + KEYS,
      );
      expect(env).toContain('MINIO_BUILTIN=true');
      expect(env).toContain('S3_ACCESS_KEY_ID=StoredKey12345');
      expect(env).toContain('S3_SECRET_ACCESS_KEY=StoredSecret1234567890');
    });

    it('keeps them when the environment pins the bundled endpoint', () => {
      process.env.S3_ENDPOINT = 'http://minio:9000';
      recordPinnedEnvKeys({ S3_ENDPOINT: 'http://minio:9000' });
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=false\nS3_BUCKET=media\n' + KEYS,
      );
      expect(env).toContain('S3_ACCESS_KEY_ID=StoredKey12345');
    });

    it('keeps them beside a stored built-in flag when the environment pins another endpoint', () => {
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      recordPinnedEnvKeys({ S3_ENDPOINT: 'https://s3.example.com' });
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=http://minio:9000\nS3_BUCKET=openwa\n' + KEYS,
      );
      expect(env).toContain('S3_ACCESS_KEY_ID=StoredKey12345');
      expect(env).toContain('S3_SECRET_ACCESS_KEY=StoredSecret1234567890');
    });

    it('keeps the legacy names the bundled container was created with', () => {
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=http://minio:9000\nS3_ACCESS_KEY=LegacyKey12345\nS3_SECRET_KEY=LegacySecret1234567890\n',
      );
      expect(env).toContain('S3_ACCESS_KEY_ID=LegacyKey12345');
      expect(env).toContain('S3_SECRET_ACCESS_KEY=LegacySecret1234567890');
    });

    it('still resets the keys of another endpoint', () => {
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=s3\nMINIO_BUILTIN=false\nS3_ENDPOINT=https://s3.example.com\nS3_BUCKET=media\n' + KEYS,
      );
      expect(env).toContain('S3_ACCESS_KEY_ID=minioadmin');
      expect(env).toContain('S3_SECRET_ACCESS_KEY=minioadmin');
      expect(env).not.toContain('StoredKey12345');
    });

    const STORED = 'STORAGE_TYPE=s3\nMINIO_BUILTIN=false\nS3_BUCKET=openwa\n' + KEYS;
    it.each(HOST_SPELLINGS.storage.reach)('keeps them under %j in the file or pinned', host => {
      expect(written({ storage: { type: 's3', builtIn: true } }, `${STORED}S3_ENDPOINT=${host}\n`)).toContain(
        'S3_SECRET_ACCESS_KEY=StoredSecret1234567890',
      );
      process.env.S3_ENDPOINT = host;
      recordPinnedEnvKeys({ S3_ENDPOINT: host });
      expect(written({ storage: { type: 's3', builtIn: true } }, STORED)).toContain('S3_ACCESS_KEY_ID=StoredKey12345');
    });
    it.each(HOST_SPELLINGS.storage.elsewhere)('still resets them under %j in the file', host => {
      expect(written({ storage: { type: 's3', builtIn: true } }, `${STORED}S3_ENDPOINT=${host}\n`)).toContain(
        'S3_ACCESS_KEY_ID=minioadmin',
      );
    });
  });

  // A file naming the bundled container beside an external database or bucket reads as built-in, so the page sends
  // builtIn true for it on a save of any other card. The next boot already dials that container with the stored
  // user, database, schema and bucket, and such a save keeps them.
  describe('built-in save over a database and bucket the bundled containers already serve', () => {
    const FILE = (db: string, s3: string) =>
      `DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=${db}\nDATABASE_USERNAME=app\n` +
      'DATABASE_PASSWORD=AppPw12345!\nDATABASE_NAME=appdb\nPOSTGRES_SCHEMA=tenant\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
      `S3_ENDPOINT=${s3}\nS3_BUCKET=media\nS3_REGION=eu-west-1\nS3_ACCESS_KEY_ID=AppKey1234567\n` +
      'S3_SECRET_ACCESS_KEY=AppSecret1234567890\n';
    // What the page sends when the operator saves another card: the toggles seeded on, the hidden fields as loaded.
    const pageSave = (db: string, s3: string) => ({
      database: {
        type: 'postgres',
        builtIn: true,
        host: db,
        port: '5432',
        username: 'app',
        password: '',
        database: 'appdb',
        schema: 'tenant',
        poolSize: 10,
        sslEnabled: false,
        sslRejectUnauthorized: true,
      },
      storage: {
        type: 's3',
        builtIn: true,
        localPath: './data/media',
        s3Bucket: 'media',
        s3Region: 'eu-west-1',
        s3AccessKey: '',
        s3SecretKey: '',
        s3Endpoint: s3,
      },
      engine: { headless: false },
    });

    afterEach(() => {
      delete process.env.DATABASE_HOST;
      delete process.env.S3_ENDPOINT;
      recordPinnedEnvKeys({});
    });

    it.each(HOST_SPELLINGS.database.reach.map((db, i) => [db, HOST_SPELLINGS.storage.reach[i]]))(
      'keeps them under %j and %j',
      (db, s3) => {
        const env = written(pageSave(db, s3), FILE(db, s3));
        for (const line of ['DATABASE_USERNAME=app', 'DATABASE_NAME=appdb', 'POSTGRES_SCHEMA=tenant']) {
          expect(env).toContain(line);
        }
        expect(env).toContain('S3_BUCKET=media');
        expect(env).toContain('S3_REGION=eu-west-1');
      },
    );

    it('writes the bundled ones over another server, as a switch to the built-in container', () => {
      const env = written(
        pageSave('db.example.com', 'https://s3.example.com'),
        FILE('db.example.com', 'https://s3.example.com'),
      );
      for (const line of ['DATABASE_USERNAME=openwa', 'DATABASE_NAME=openwa', 'POSTGRES_SCHEMA=public']) {
        expect(env).toContain(line);
      }
      expect(env).toContain('S3_BUCKET=openwa');
      expect(env).toContain('S3_REGION=us-east-1');
    });

    // A SQLite boot dials no PostgreSQL, and its DATABASE_NAME is a file path.
    it('writes the bundled ones when the next boot runs SQLite beside a bundled host pin', () => {
      process.env.DATABASE_HOST = 'postgres';
      recordPinnedEnvKeys({ DATABASE_HOST: 'postgres' });
      const env = written(
        { database: { type: 'postgres', builtIn: true } },
        'DATABASE_TYPE=sqlite\nPOSTGRES_BUILTIN=false\nDATABASE_NAME=./data/openwa.sqlite\n',
      );
      expect(env).toContain('DATABASE_NAME=openwa');
      expect(env).not.toContain('openwa.sqlite');
    });

    // Likewise local storage dials no MinIO, whatever bucket an older file left behind.
    it('writes the bundled bucket when the next boot keeps local storage beside a bundled endpoint pin', () => {
      process.env.S3_ENDPOINT = 'http://minio:9000';
      recordPinnedEnvKeys({ S3_ENDPOINT: 'http://minio:9000' });
      const env = written(
        { storage: { type: 's3', builtIn: true } },
        'STORAGE_TYPE=local\nMINIO_BUILTIN=false\nS3_BUCKET=media\nS3_REGION=eu-west-1\n',
      );
      expect(env).toContain('S3_BUCKET=openwa');
      expect(env).toContain('S3_REGION=us-east-1');
    });

    // A database and bucket of their own on the bundled containers, switched away to other servers and saved without a
    // restart, then switched back: the file names the other servers now, but the running process still dials the
    // bundled containers with the values its boot loaded into the environment, and those are what they serve.
    describe('switched away and back before a restart', () => {
      const RUNNING: Record<string, string> = {
        DATABASE_TYPE: 'postgres',
        DATABASE_HOST: 'openwa-postgres',
        DATABASE_USERNAME: 'app',
        DATABASE_PASSWORD: 'RunPw12345!',
        DATABASE_NAME: 'appdb',
        POSTGRES_SCHEMA: 'tenant',
        STORAGE_TYPE: 's3',
        S3_ENDPOINT: 'http://openwa-minio:9000',
        S3_BUCKET: 'media',
        S3_REGION: 'eu-west-1',
        S3_ACCESS_KEY_ID: 'RunKey1234567',
        S3_SECRET_ACCESS_KEY: 'RunSecret1234567890',
      };
      // What the switch away wrote: the other servers, with a password, bucket and keys of their own typed.
      const SWITCHED =
        'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.ext.example\nDATABASE_USERNAME=app\n' +
        'DATABASE_PASSWORD=ExtPw12345!\nDATABASE_NAME=extdb\nPOSTGRES_SCHEMA=tenant\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
        'S3_ENDPOINT=https://s3.ext.example\nS3_BUCKET=newbucket\nS3_REGION=us-west-2\nS3_ACCESS_KEY_ID=ExtKey1234567\n' +
        'S3_SECRET_ACCESS_KEY=ExtSecret1234567890\n';
      const KEYS = [
        'DATABASE_HOST',
        'DATABASE_USERNAME',
        'DATABASE_PASSWORD',
        'DATABASE_NAME',
        'POSTGRES_SCHEMA',
        'S3_ENDPOINT',
        'S3_BUCKET',
        'S3_REGION',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ];
      const switchBack = (running: Record<string, string>) => {
        Object.assign(process.env, running);
        // These runtime values came from the generated file, so they are not host overrides of the new save.
        const precedence =
          jest.requireActual<typeof import('../../config/env-precedence')>('../../config/env-precedence');
        const wasOsProvided = precedence.isOsProvidedEnv;
        const source = jest
          .spyOn(precedence, 'isOsProvidedEnv')
          .mockImplementation(key => !Object.prototype.hasOwnProperty.call(running, key) && wasOsProvided(key));
        try {
          const env = jest
            .requireActual<typeof import('dotenv')>('dotenv')
            .parse(
              written(
                { database: { type: 'postgres', builtIn: true }, storage: { type: 's3', builtIn: true } },
                SWITCHED,
              ),
            );
          return Object.fromEntries(KEYS.map(key => [key, env[key]]));
        } finally {
          source.mockRestore();
        }
      };
      // Nothing is pinned: the running process holds the values its boot loaded from the file.
      afterEach(() => {
        for (const key of Object.keys(RUNNING)) delete process.env[key];
      });

      it('keeps the user, database, schema, password, bucket, region and keys the running process uses there', () => {
        expect(switchBack(RUNNING)).toEqual({
          DATABASE_HOST: 'postgres',
          DATABASE_USERNAME: 'app',
          DATABASE_PASSWORD: 'RunPw12345!',
          DATABASE_NAME: 'appdb',
          POSTGRES_SCHEMA: 'tenant',
          S3_ENDPOINT: 'http://minio:9000',
          S3_BUCKET: 'media',
          S3_REGION: 'eu-west-1',
          S3_ACCESS_KEY_ID: 'RunKey1234567',
          S3_SECRET_ACCESS_KEY: 'RunSecret1234567890',
        });
      });

      it.each(HOST_SPELLINGS.database.reach.map((db, i) => [db, HOST_SPELLINGS.storage.reach[i]]))(
        'keeps them while the running process dials %j and %j',
        (db, s3) => {
          const env = switchBack({ ...RUNNING, DATABASE_HOST: db, S3_ENDPOINT: s3 });
          expect([env.DATABASE_NAME, env.DATABASE_PASSWORD, env.S3_BUCKET, env.S3_ACCESS_KEY_ID]).toEqual([
            'appdb',
            'RunPw12345!',
            'media',
            'RunKey1234567',
          ]);
        },
      );

      it('writes the bundled ones while the running process dials other servers', () => {
        expect(
          switchBack({ ...RUNNING, DATABASE_HOST: 'db.old.example', S3_ENDPOINT: 'https://s3.old.example' }),
        ).toEqual({
          DATABASE_HOST: 'postgres',
          DATABASE_USERNAME: 'openwa',
          DATABASE_PASSWORD: 'openwa',
          DATABASE_NAME: 'openwa',
          POSTGRES_SCHEMA: 'public',
          S3_ENDPOINT: 'http://minio:9000',
          S3_BUCKET: 'openwa',
          S3_REGION: 'us-east-1',
          S3_ACCESS_KEY_ID: 'minioadmin',
          S3_SECRET_ACCESS_KEY: 'minioadmin',
        });
      });

      it('writes the bundled ones while the running process uses SQLite and local storage', () => {
        const env = switchBack({
          ...RUNNING,
          DATABASE_TYPE: 'sqlite',
          DATABASE_NAME: './data/running.sqlite',
          STORAGE_TYPE: 'local',
        });
        expect([env.DATABASE_NAME, env.DATABASE_PASSWORD, env.S3_BUCKET, env.S3_ACCESS_KEY_ID]).toEqual([
          'openwa',
          'openwa',
          'openwa',
          'minioadmin',
        ]);
      });

      // A file that already names the bundled containers is the choice the next boot makes: its values stay.
      it('keeps the stored ones of a file that names the bundled containers over the running ones', () => {
        Object.assign(process.env, RUNNING);
        const env = jest
          .requireActual<typeof import('dotenv')>('dotenv')
          .parse(
            written(
              { database: { type: 'postgres', builtIn: true }, storage: { type: 's3', builtIn: true } },
              SWITCHED.replace('db.ext.example', 'postgres').replace('https://s3.ext.example', 'http://minio:9000'),
            ),
          );
        expect([env.DATABASE_NAME, env.DATABASE_PASSWORD, env.S3_BUCKET, env.S3_REGION, env.S3_ACCESS_KEY_ID]).toEqual([
          'extdb',
          'ExtPw12345!',
          'newbucket',
          'us-west-2',
          'ExtKey1234567',
        ]);
      });
    });
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
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
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

    it('accepts external S3 credentials supplied under the legacy names boot still reads', () => {
      // main.ts and storage.service fall back to S3_ACCESS_KEY / S3_SECRET_KEY when the canonical
      // names are unset, so a deployment configured that way boots and must be able to save.
      process.env.STORAGE_TYPE = 's3';
      process.env.S3_ENDPOINT = 'https://s3.example.com';
      process.env.S3_ACCESS_KEY = 'AKIAEXAMPLESTRONG1';
      process.env.S3_SECRET_KEY = 'Sup3rSecretS3Key!';
      const env = written({ queue: { enabled: false } });
      expect(env).toContain('QUEUE_ENABLED=false');
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

      it('honors a value from the project .env, which also outranks the saved file at boot', () => {
        // load-env takes the host snapshot before ./.env loads, but ./.env still loads ahead of
        // data/.env.generated with override:false, so its password is the one the next boot sees.
        recordOsEnvKeys({});
        recordPinnedEnvKeys({ DATABASE_PASSWORD: 'Sup3rSecret!' });
        process.env.DATABASE_PASSWORD = 'Sup3rSecret!';
        try {
          const env = written(
            {
              database: {
                type: 'postgres',
                builtIn: false,
                host: 'db.example.com',
                username: 'app',
                database: 'appdb',
                password: '',
              },
            },
            'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.example.com\n',
          );
          expect(env).toContain('DATABASE_HOST=db.example.com');
        } finally {
          recordPinnedEnvKeys({});
        }
      });

      it('a blank project .env line keeps the key blank at boot, so fresh S3 keys cannot satisfy the guard', () => {
        // clearBlankEnv runs on the host env before either snapshot, so a pinned blank can only be a
        // `KEY=` line in ./.env. dotenv keeps it, data/.env.generated cannot fill it, and the next
        // production boot refuses the empty credentials: the save must be refused the same way.
        recordOsEnvKeys({});
        recordPinnedEnvKeys({ S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' });
        process.env.S3_ACCESS_KEY_ID = '';
        process.env.S3_SECRET_ACCESS_KEY = '';
        try {
          expectRejected(
            {
              storage: {
                type: 's3',
                builtIn: false,
                s3Bucket: 'b',
                s3AccessKey: 'AKIAEXAMPLESTRONG1',
                s3SecretKey: 'Sup3rSecretS3Key!',
                s3Endpoint: 'https://s3.example.com',
              },
            },
            'STORAGE_TYPE=local\n',
            /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
          );
        } finally {
          recordPinnedEnvKeys({});
        }
      });
    });
  });
});

describe('InfraConfigController.saveConfig persists strictly-coerced form booleans', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

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
        username: 'app',
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

describe('InfraConfigController.getConfig (#226)', () => {
  it('returns the saved config shape without echoing secrets', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      'DATABASE_TYPE=postgres\nDATABASE_HOST=db\nDATABASE_PASSWORD=secret\nSESSION_DATA_PATH=./sess\nENGINE_TYPE=baileys\nSTORAGE_TYPE=s3\nS3_ACCESS_KEY_ID=ak\nS3_SECRET_ACCESS_KEY=sk\n',
    );
    const controller = new InfraConfigController({} as never, {} as never, {} as never);

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

  it('reports S3 credentials set under the legacy names the runtime still reads', () => {
    recordPinnedEnvKeys({ S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });
    process.env.S3_ACCESS_KEY = 'ak';
    process.env.S3_SECRET_KEY = 'sk';
    try {
      expect(
        new InfraConfigController({} as never, {} as never, {} as never).getConfig().storage.s3CredentialsSet,
      ).toBe(true);
    } finally {
      delete process.env.S3_ACCESS_KEY;
      delete process.env.S3_SECRET_KEY;
      recordPinnedEnvKeys({});
    }
  });
});

describe('InfraConfigController.getConfig reflects environment-pinned values (#1313)', () => {
  // A compose `environment:` value outranks data/.env.generated at every boot, so the form must
  // read it back instead of the first-run defaults the file still holds.
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);
  const PINNED_KEYS = ['ENGINE_TYPE', 'DATABASE_TYPE', 'REDIS_ENABLED', 'QUEUE_ENABLED'];
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    savedEnv = PINNED_KEYS.map(k => [k, process.env[k]]);
    for (const k of PINNED_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Restore the permissive snapshot the rest of the file assumes (an empty one, like no snapshot,
    // leaves isEnvPinned false everywhere, which is what the other describes rely on).
    recordPinnedEnvKeys({});
  });

  it('reports host-provided engine/database/redis values over the first-run file defaults', () => {
    // The exact #1313 deployment: everything set via compose environment:, no .env, and the
    // first-run data/.env.generated holding sqlite/false with no ENGINE_TYPE line at all.
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('DATABASE_TYPE=sqlite\nREDIS_ENABLED=false\n');

    process.env.ENGINE_TYPE = 'baileys';
    process.env.DATABASE_TYPE = 'postgres';
    process.env.REDIS_ENABLED = 'true';
    recordPinnedEnvKeys(process.env);

    const cfg = newController().getConfig();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');

    expect(cfg.engine.type).toBe('baileys');
    expect(cfg.database.type).toBe('postgres');
    expect(cfg.redis.enabled).toBe(true);
  });

  it('a saved-but-not-yet-restarted file value wins over the stale process.env copy', () => {
    // Boot loaded the OLD file value into process.env (override:false), then the dashboard saved a
    // new one. The key is not pinned (it never came from the host or .env), so the freshly saved
    // file must hydrate the form — otherwise it flips back to the pre-save value (#226/#1082).
    recordPinnedEnvKeys({}); // the host supplied nothing; ENGINE_TYPE below came from the file
    process.env.ENGINE_TYPE = 'whatsapp-web.js';
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('ENGINE_TYPE=baileys\n');

    expect(newController().getConfig().engine.type).toBe('baileys');

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  it('a blank pinned value hides the file value, as it does at boot', () => {
    // clearBlankEnv runs on the host env before the snapshot, so a pinned blank can only be an
    // `ENGINE_TYPE=` line in ./.env. dotenv keeps it and data/.env.generated cannot fill it, so the
    // runtime falls back to the default engine and the form must report that, not the file value.
    recordPinnedEnvKeys({ ENGINE_TYPE: '' });
    process.env.ENGINE_TYPE = '';
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('ENGINE_TYPE=baileys\n');

    expect(newController().getConfig().engine.type).toBe('whatsapp-web.js');

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  it('a blank pinned value on a key boot does NOT clear still wins as blank, mirroring the runtime read', () => {
    // QUEUE_ENABLED is not blank-forwarded by compose, so clearBlankEnv leaves a blank host/.env
    // value in place: configuration.ts's `process.env.QUEUE_ENABLED === 'true'` then reads false,
    // and the form must agree instead of falling through to a contradicting file value.
    recordPinnedEnvKeys({ QUEUE_ENABLED: '' });
    process.env.QUEUE_ENABLED = '';
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('QUEUE_ENABLED=true\n');

    expect(newController().getConfig().queue.enabled).toBe(false);

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });
});

// The saved built-in mode, for every state of the saved file and of what the environment pins for the service's host
// key (the rule is in test/fixtures/builtin-mode-cases.ts). Each case also fills the OTHER two services with the
// opposite state and pin, so a service reading another one's keys gets the wrong answer.
describe('InfraConfigController.getConfig answers the saved built-in mode for every file and pin state', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);
  const otherState = (state: FileState): FileState => (state === 'stored-true' ? 'stored-false' : 'stored-true');
  const otherPin = (pin: PinState): PinState => (pin === 'external' ? 'bundled' : 'external');
  let pinnedKeys: string[] = [];

  const arrange = (service: ServiceName, state: FileState, pin: PinState, extraPins: Record<string, string> = {}) => {
    const lines: string[] = [];
    const pins: Record<string, string> = { ...extraPins };
    for (const name of SERVICE_NAMES) {
      const own = name === service;
      lines.push(...fileLines(name, own ? state : otherState(state)));
      const host = pinnedHost(name, own ? pin : otherPin(pin));
      if (host !== undefined) pins[SERVICES[name].host] = host;
    }
    recordPinnedEnvKeys(pins);
    for (const [key, value] of Object.entries(pins)) process.env[key] = value;
    pinnedKeys = Object.keys(pins);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(`${lines.join('\n')}\n`);
  };

  afterEach(() => {
    for (const key of pinnedKeys) delete process.env[key];
    pinnedKeys = [];
    delete process.env.POSTGRES_BUILTIN;
    delete process.env.REDIS_BUILTIN;
    delete process.env.MINIO_BUILTIN;
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  const modeOf = (cfg: ReturnType<InfraConfigController['getConfig']>, service: ServiceName): SavedMode => {
    const section = cfg[service];
    return { builtIn: section.builtIn, builtInSet: section.builtInSet };
  };

  describe.each(SERVICE_NAMES)('%s', service => {
    for (const state of FILE_STATES) {
      for (const pin of PIN_STATES) {
        it(`a ${state} file with ${pin === 'none' ? 'no host pin' : `the host pinned ${pin}`}`, () => {
          arrange(service, state, pin);

          expect(modeOf(newController().getConfig(), service)).toEqual(EXPECTED_MODE[state][pin]);
        });
      }
    }
  });

  // A host that reaches the bundled container in another spelling reads as the bundled host, pinned or in the file;
  // any other host does not.
  describe.each(SERVICE_NAMES)('%s under another spelling of the bundled host', service => {
    const spec = SERVICES[service];
    const inFile = (host: string) => {
      recordPinnedEnvKeys({});
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        `${spec.selection}=${spec.selected}\n${spec.flag}=false\n${spec.host}=${host}\n`,
      );
      return modeOf(newController().getConfig(), service);
    };
    const pinned = (host: string) => {
      process.env[spec.host] = host;
      pinnedKeys = [spec.host];
      recordPinnedEnvKeys({ [spec.host]: host });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(`${spec.selection}=${spec.selected}\n${spec.flag}=false\n`);
      return modeOf(newController().getConfig(), service);
    };
    it.each(HOST_SPELLINGS[service].reach)('%j pinned or in the file reads built-in', host => {
      expect(inFile(host)).toEqual({ builtIn: true, builtInSet: false });
      expect(pinned(host)).toEqual({ builtIn: true, builtInSet: false });
    });
    it.each(HOST_SPELLINGS[service].elsewhere)('%j pinned or in the file does not', host => {
      expect(inFile(host)).toEqual({ builtIn: false, builtInSet: true });
      expect(pinned(host)).toEqual({ builtIn: false, builtInSet: false });
    });
  });

  // The first boot writes every flag false next to a service that is not selected. With the compose .env pinning
  // the bundled hosts and the containers running, that file must not read as three saved external services.
  it('the first-boot file under the compose .env pins reads as bundled, never as a saved external choice', () => {
    for (const service of SERVICE_NAMES) {
      arrange(service, 'template', 'bundled');
      expect(modeOf(newController().getConfig(), service)).toEqual({ builtIn: true, builtInSet: false });
    }
  });

  it('an external pin over a flag saved true reads as external, not as a pending switch to built-in', () => {
    for (const service of SERVICE_NAMES) {
      arrange(service, 'stored-true', 'external');
      expect(modeOf(newController().getConfig(), service)).toEqual({ builtIn: false, builtInSet: false });
    }
  });

  // A flag the environment pins only decides whether the bundled container starts at boot. Whether the service is
  // built-in is the host the next boot dials: the pinned one, else the file's beside the pinned flag, which then
  // counts as a saved choice.
  describe.each(SERVICE_NAMES)('%s beside a flag the environment pins', service => {
    for (const state of FILE_STATES) {
      for (const flag of ['true', 'false'] as const) {
        for (const pin of PIN_STATES) {
          const host = pin === 'none' ? 'no host pin' : `the host pinned ${pin}`;
          it(`a ${state} file with the flag pinned ${flag} and ${host}`, () => {
            arrange(service, state, pin, { [SERVICES[service].flag]: flag });

            expect(modeOf(newController().getConfig(), service)).toEqual(
              pin === 'none' ? EXPECTED_MODE_FLAG_PINNED[state][flag] : EXPECTED_MODE[state][pin],
            );
          });
        }
      }
    }
  });

  // The switch the page writes beside flags the environment pins true (the documented manual flags): the flags false
  // and external hosts in the file. The restart applies it, so it reads as the saved external choice it is.
  it('a switch to external servers saved beside flags pinned true reads as external', () => {
    const pins = { POSTGRES_BUILTIN: 'true', REDIS_BUILTIN: 'true', MINIO_BUILTIN: 'true' };
    recordPinnedEnvKeys(pins);
    Object.assign(process.env, pins);
    pinnedKeys = Object.keys(pins);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.ext.example\nREDIS_ENABLED=true\n' +
        'REDIS_BUILTIN=false\nREDIS_HOST=cache.ext.example\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
        'S3_ENDPOINT=https://s3.ext.example\n',
    );

    const cfg = newController().getConfig();

    for (const service of SERVICE_NAMES) expect(modeOf(cfg, service)).toEqual({ builtIn: false, builtInSet: true });
  });
});

// The save of what GET /config reports, with an unrelated setting changed, as the Infrastructure page sends it after
// a switch to external servers beside flags the environment pins true: the next boot keeps dialling those servers
// with the values saved for them. The pinned flags only start the bundled containers at boot.
describe('InfraConfigController.saveConfig beside flags the environment pins true', () => {
  const STORED =
    'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.ext.example\nDATABASE_PORT=5432\n' +
    'DATABASE_USERNAME=app\nDATABASE_PASSWORD=ExtPw12345!\nDATABASE_NAME=appdb\nPOSTGRES_SCHEMA=tenant\n' +
    'REDIS_ENABLED=true\nREDIS_BUILTIN=false\nREDIS_HOST=cache.ext.example\nREDIS_PORT=6380\n' +
    'REDIS_PASSWORD=RedisPw123456\nQUEUE_ENABLED=false\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
    'S3_ENDPOINT=https://s3.ext.example\nS3_BUCKET=media\nS3_REGION=eu-west-1\nS3_ACCESS_KEY_ID=AKIAEXTERNAL12345\n' +
    'S3_SECRET_ACCESS_KEY=ExternalSecret1234567890\nPUPPETEER_HEADLESS=true\n';
  const pins = { POSTGRES_BUILTIN: 'true', REDIS_BUILTIN: 'true', MINIO_BUILTIN: 'true' };
  const dotenv = jest.requireActual<typeof import('dotenv')>('dotenv');

  beforeEach(() => {
    recordPinnedEnvKeys(pins);
    Object.assign(process.env, pins);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(STORED);
    (fs.writeFileSync as jest.Mock).mockClear();
  });
  afterEach(() => {
    for (const key of Object.keys(pins)) delete process.env[key];
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  it('keeps every external value when only Headless Mode changes', () => {
    const controller = new InfraConfigController({ getAvailableEngines: () => [] } as never, {} as never, {} as never);
    const cfg = controller.getConfig();
    // What the form seeds from GET /config and sends: no host is pinned, so every flag is sent; secrets are blank.
    controller.saveConfig({
      database: { ...cfg.database, password: '' },
      redis: { enabled: cfg.redis.enabled, builtIn: cfg.redis.builtIn, host: cfg.redis.host, port: cfg.redis.port },
      queue: cfg.queue,
      storage: {
        type: cfg.storage.type,
        builtIn: cfg.storage.builtIn,
        s3Bucket: cfg.storage.s3Bucket,
        s3Region: cfg.storage.s3Region,
        s3Endpoint: cfg.storage.s3Endpoint,
        s3AccessKey: '',
        s3SecretKey: '',
      },
      engine: { headless: !cfg.engine.headless },
    });

    const written = dotenv.parse(((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1]);
    expect(written).toEqual({
      ...dotenv.parse(STORED),
      DATABASE_POOL_SIZE: '10',
      DATABASE_SSL: 'false',
      PUPPETEER_HEADLESS: 'false',
    });
  });
});

describe('InfraConfigController.requestRestart constrains teardown to managed profiles', () => {
  const buildController = (dockerService: Record<string, unknown>) =>
    new InfraConfigController(
      {} as never, // engineFactory
      dockerService as never,
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

  // A name every object inherits is no profile either: it is ignored like any other unknown name, and the managed
  // names beside it still act.
  describe('POST /api/infra/restart with a profile name an object inherits', () => {
    const stopManagedService = jest.fn().mockResolvedValue(true);
    const orchestrateProfiles = jest.fn().mockResolvedValue({});
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [InfraConfigController],
        providers: [
          { provide: EngineFactory, useValue: {} },
          {
            provide: DockerService,
            useValue: { isDockerAvailable: () => true, stopManagedService, orchestrateProfiles },
          },
          { provide: ShutdownService, useValue: { shutdown: jest.fn() } },
        ],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      applyGlobalValidation(app);
      await app.init();
    });
    afterAll(() => app.close());
    beforeEach(() => {
      stopManagedService.mockClear();
      orchestrateProfiles.mockClear();
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])('ignores %s', async name => {
      const res = await request(app.getHttpServer() as Server)
        .post('/api/infra/restart')
        .send({ profiles: [name, 'redis'], profilesToRemove: [name, 'postgres'] });

      expect(res.status).toBe(200);
      expect(orchestrateProfiles.mock.calls).toEqual([[['redis']]]);
      expect(stopManagedService.mock.calls).toEqual([['postgres']]);
    });
  });

  describe('a service the environment pins the app to', () => {
    const KEYS = ['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT', 'DATABASE_TYPE', 'REDIS_ENABLED', 'STORAGE_TYPE'];
    let savedEnv: Array<[string, string | undefined]>;

    beforeEach(() => {
      savedEnv = KEYS.map(k => [k, process.env[k]]);
    });
    afterEach(() => {
      for (const [k, v] of savedEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      // Back to the no-snapshot default the rest of the file assumes (an empty snapshot pins nothing).
      recordPinnedEnvKeys({});
    });

    it('is never stopped, since the restarted app would still point at it', async () => {
      // The documented manual built-in Postgres setup: DATABASE_HOST=postgres in .env or on the host.
      process.env.DATABASE_HOST = 'postgres';
      process.env.REDIS_HOST = 'redis';
      process.env.S3_ENDPOINT = 'http://minio:9000';
      process.env.DATABASE_TYPE = 'postgres';
      process.env.REDIS_ENABLED = 'true';
      process.env.STORAGE_TYPE = 's3';
      recordPinnedEnvKeys(process.env);
      const stopManagedService = jest.fn().mockResolvedValue(true);
      const controller = buildController({
        isDockerAvailable: () => true,
        stopManagedService,
        orchestrateProfiles: jest.fn().mockResolvedValue({}),
      });

      const result = await controller.requestRestart({ profilesToRemove: ['postgres', 'redis', 'minio'] });

      expect(stopManagedService).not.toHaveBeenCalled();
      expect(result.profilesToRemove).toEqual([]);
    });

    it('is still stopped when the pin names a different host', async () => {
      process.env.DATABASE_HOST = 'db.example.internal';
      delete process.env.REDIS_HOST;
      delete process.env.S3_ENDPOINT;
      recordPinnedEnvKeys(process.env);
      const stopManagedService = jest.fn().mockResolvedValue(true);
      const controller = buildController({
        isDockerAvailable: () => true,
        stopManagedService,
        orchestrateProfiles: jest.fn().mockResolvedValue({}),
      });

      await controller.requestRestart({ profilesToRemove: ['postgres', 'redis'] });

      expect(stopManagedService.mock.calls.map(call => String((call as unknown[])[0])).sort()).toEqual([
        'postgres',
        'redis',
      ]);
    });
  });

  // The restart never stops a service the NEXT boot still dials, whatever the page asked for: the host the environment
  // pins when it pins one, else the host the saved file holds (the save that precedes the restart is already on disk).
  // The profile is the container to stop; PROFILE_OF maps the three managed services to it.
  describe('a service whose next-boot host is the bundled one is never stopped', () => {
    const PROFILE_OF: Record<ServiceName, string> = { database: 'postgres', redis: 'redis', storage: 'minio' };
    const HOST_STATES = ['absent', 'bundled', 'external'] as const;
    let pinnedKeys: string[] = [];

    const stoppedFor = async (service: ServiceName, filePin: string | undefined, envPin: string | undefined) => {
      const spec = SERVICES[service];
      const lines = [`${spec.selection}=${spec.selected}`, `${spec.flag}=false`];
      if (filePin !== undefined) lines.push(`${spec.host}=${filePin}`);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(`${lines.join('\n')}\n`);
      if (envPin !== undefined) {
        process.env[spec.host] = envPin;
        pinnedKeys.push(spec.host);
        recordPinnedEnvKeys({ [spec.host]: envPin });
      } else {
        recordPinnedEnvKeys({});
      }
      const stopManagedService = jest.fn().mockResolvedValue(true);
      const controller = buildController({
        isDockerAvailable: () => true,
        stopManagedService,
        orchestrateProfiles: jest.fn().mockResolvedValue({}),
      });

      const result = await controller.requestRestart({ profilesToRemove: [PROFILE_OF[service]] });

      return { stopped: stopManagedService.mock.calls.length > 0, kept: result.profilesToRemove.length === 0 };
    };

    afterEach(() => {
      for (const key of pinnedKeys) delete process.env[key];
      pinnedKeys = [];
      recordPinnedEnvKeys({});
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
    });

    describe.each(SERVICE_NAMES)('%s', service => {
      const hostFor = (state: (typeof HOST_STATES)[number]) =>
        state === 'absent'
          ? undefined
          : state === 'bundled'
            ? SERVICES[service].bundledHost
            : SERVICES[service].externalHost;
      for (const fileHost of HOST_STATES) {
        for (const envHost of HOST_STATES) {
          const file = hostFor(fileHost);
          const env = hostFor(envHost);
          // The next boot dials the environment's host when it pins one, else the file's.
          const dialled = envHost !== 'absent' ? env : file;
          const keeps = dialled === SERVICES[service].bundledHost;
          it(`file host ${fileHost}, environment host ${envHost}: ${keeps ? 'kept running' : 'stopped'}`, async () => {
            const { stopped, kept } = await stoppedFor(service, file, env);

            expect(stopped).toBe(!keeps);
            expect(kept).toBe(keeps);
          });
        }
      }
    });

    // The bundled container answers to its network alias and its container name, in any letter case and as an
    // absolute DNS name with a trailing dot, so a host spelled any of these ways still reaches it.
    describe.each(SERVICE_NAMES)('%s under another spelling of the bundled host', service => {
      for (const host of HOST_SPELLINGS[service].reach) {
        it(`keeps it under ${JSON.stringify(host)}, in the file or pinned`, async () => {
          expect((await stoppedFor(service, host, undefined)).stopped).toBe(false);
          expect((await stoppedFor(service, SERVICES[service].externalHost, host)).stopped).toBe(false);
        });
      }
      for (const host of HOST_SPELLINGS[service].elsewhere) {
        it(`still stops it under ${JSON.stringify(host)}`, async () => {
          expect((await stoppedFor(service, host, undefined)).stopped).toBe(true);
        });
      }
    });

    it('keeps the container when the flag is pinned off over a stored bundled host', async () => {
      process.env.REDIS_BUILTIN = 'false';
      pinnedKeys.push('REDIS_BUILTIN');
      const { stopped } = await stoppedFor('redis', 'redis', undefined);

      expect(stopped).toBe(false);
    });

    // The page's own save for switching a bundled service off, then Restart Now with the container it runs: the
    // file the save wrote is what the restart reads, and nothing in it may keep the container for a service that is
    // no longer in use.
    describe.each([
      ['database', { database: { type: 'sqlite', builtIn: true, host: 'postgres' } }],
      ['redis', { redis: { enabled: false, builtIn: true, host: 'redis', port: '6379' }, queue: { enabled: false } }],
      ['storage', { storage: { type: 'local', builtIn: true, s3Endpoint: 'http://minio:9000' } }],
    ] as const)('%s switched off from the page', (service, payload) => {
      it('is stopped by the restart that follows the save', async () => {
        const saved = [
          'DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=true\nDATABASE_HOST=postgres\nDATABASE_USERNAME=openwa\nDATABASE_PASSWORD=openwa',
          'REDIS_ENABLED=true\nREDIS_BUILTIN=true\nREDIS_HOST=redis\nREDIS_PORT=6379\nQUEUE_ENABLED=true',
          'STORAGE_TYPE=s3\nMINIO_BUILTIN=true\nS3_ENDPOINT=http://minio:9000\nS3_ACCESS_KEY_ID=minioadmin',
          'S3_SECRET_ACCESS_KEY=minioadmin\n',
        ].join('\n');
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue(saved);
        (fs.writeFileSync as jest.Mock).mockClear();
        recordPinnedEnvKeys({});
        const stopManagedService = jest.fn().mockResolvedValue(true);
        const controller = buildController({
          isDockerAvailable: () => true,
          stopManagedService,
          orchestrateProfiles: jest.fn().mockResolvedValue({}),
        });

        const { profiles } = controller.saveConfig(payload);
        const written = ((fs.writeFileSync as jest.Mock).mock.calls as Array<[string, string]>)[0][1];
        (fs.readFileSync as jest.Mock).mockReturnValue(written);
        await controller.requestRestart({ profiles, profilesToRemove: [PROFILE_OF[service]] });

        expect(stopManagedService).toHaveBeenCalledWith(PROFILE_OF[service]);
      });
    });
  });

  // The start side of the same rule: the host the environment pins outranks the saved file, so a bundled container
  // started for a host pinned elsewhere would run with nothing dialling it.
  describe('a bundled service whose host the environment pins elsewhere is never started', () => {
    const PROFILE_OF: Record<ServiceName, string> = { database: 'postgres', redis: 'redis', storage: 'minio' };
    let pinnedKeys: string[] = [];

    afterEach(() => {
      for (const key of pinnedKeys) delete process.env[key];
      pinnedKeys = [];
      recordPinnedEnvKeys({});
    });

    describe.each(SERVICE_NAMES)('%s', service => {
      it.each(PIN_STATES)('host pinned %s', async pin => {
        const host = pinnedHost(service, pin);
        const key = SERVICES[service].host;
        if (host !== undefined) {
          process.env[key] = host;
          pinnedKeys.push(key);
        }
        recordPinnedEnvKeys(host === undefined ? {} : { [key]: host });
        const orchestrateProfiles = jest.fn().mockResolvedValue({});
        const controller = buildController({
          isDockerAvailable: () => true,
          stopManagedService: jest.fn().mockResolvedValue(true),
          orchestrateProfiles,
        });

        const result = await controller.requestRestart({ profiles: [PROFILE_OF[service]] });

        const starts = pin !== 'external';
        expect(orchestrateProfiles).toHaveBeenCalledTimes(starts ? 1 : 0);
        expect(result.profiles).toEqual(starts ? [PROFILE_OF[service]] : []);
      });

      // The start rule reads a host the way the stop rule does: a spelling that reaches the bundled container is the
      // container the next boot dials, so the restart starts it.
      it.each([
        ...HOST_SPELLINGS[service].reach.map(host => [host, true] as const),
        ...HOST_SPELLINGS[service].elsewhere.map(host => [host, false] as const),
      ])('host pinned to %j is started: %s', async (host, starts) => {
        const key = SERVICES[service].host;
        process.env[key] = host;
        pinnedKeys.push(key);
        recordPinnedEnvKeys({ [key]: host });
        const orchestrateProfiles = jest.fn().mockResolvedValue({});
        const controller = buildController({
          isDockerAvailable: () => true,
          stopManagedService: jest.fn().mockResolvedValue(true),
          orchestrateProfiles,
        });

        const result = await controller.requestRestart({ profiles: [PROFILE_OF[service]] });

        expect(result.profiles).toEqual(starts ? [PROFILE_OF[service]] : []);
      });
    });

    it('leaves it out of the no-Docker signal file too', async () => {
      process.env.DATABASE_HOST = 'db.external.example';
      pinnedKeys.push('DATABASE_HOST');
      recordPinnedEnvKeys({ DATABASE_HOST: 'db.external.example' });
      const writeFileSync = fs.writeFileSync as jest.Mock;
      writeFileSync.mockClear();

      await buildController({ isDockerAvailable: () => false }).requestRestart({ profiles: ['postgres', 'redis'] });

      const written = (writeFileSync.mock.calls as Array<[unknown, unknown]>).find(call =>
        String(call[0]).endsWith('.orchestration-request.json'),
      );
      expect((JSON.parse(String(written![1])) as { profiles: string[] }).profiles).toEqual(['redis']);
    });
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

// The infra module's sensitive ADMIN operations (credential config write, restart/Docker
// orchestration, full-DB + storage export/import) must leave an audit trail — each emits an AuditAction.
describe('InfraConfigController audit trail (light-dependency handlers)', () => {
  const makeAudit = (): { logInfo: jest.Mock } => ({ logInfo: jest.fn().mockResolvedValue(null) });

  // Positional constructor: (engineFactory, dockerService, shutdownService, auditService?).
  // auditService is the last @Optional arg.
  const build = (
    audit: { logInfo: jest.Mock },
    overrides: Partial<{
      engineFactory: unknown;
      dockerService: unknown;
      shutdownService: unknown;
    }> = {},
  ): InfraConfigController =>
    new InfraConfigController(
      (overrides.engineFactory ?? {}) as never,
      (overrides.dockerService ?? {}) as never,
      (overrides.shutdownService ?? {}) as never,
      audit as never,
    );

  it('saveConfig emits INFRA_CONFIG_SAVED without leaking secret values into the metadata', () => {
    const audit = makeAudit();
    build(audit).saveConfig({
      database: { type: 'postgres', host: 'db', username: 'app', password: 'topsecret' },
    } as never);
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
      dockerService: { isDockerAvailable: () => false },
      shutdownService: { shutdown: jest.fn() },
    });
    await controller.requestRestart({ profiles: ['postgres'], profilesToRemove: [] });
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { profiles: string[] } }]>;
    expect(calls[0][0]).toBe(AuditAction.INFRA_RESTART_REQUESTED);
    expect(calls[0][1].metadata.profiles).toEqual(['postgres']);
  });
});

describe('InfraConfigController built-in Redis transport', () => {
  const external =
    'DATABASE_TYPE=sqlite\nSTORAGE_TYPE=local\nREDIS_ENABLED=true\nREDIS_BUILTIN=false\n' +
    'REDIS_HOST=cache.external.invalid\nREDIS_PORT=6379\nREDIS_TLS=true\n';
  const keys = ['REDIS_TLS', 'REDIS_HOST', 'REDIS_ENABLED', 'REDIS_BUILTIN', 'QUEUE_ENABLED', 'CACHE_ENABLED'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    recordOsEnvKeys({});
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(external);
    (fs.writeFileSync as jest.Mock).mockClear();
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    recordOsEnvKeys({});
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  function write(redis: NonNullable<SaveConfigDto['redis']>): Record<string, string> {
    const controller = new InfraConfigController({} as never, {} as never, {} as never);
    expect(controller.saveConfig({ redis }).saved).toBe(true);
    const content = jest.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string;
    return jest.requireActual<typeof import('dotenv')>('dotenv').parse(content);
  }

  it('resets saved TLS when switching to the plaintext built-in Redis', () => {
    const env = write({ enabled: true, builtIn: true });
    expect(env.REDIS_HOST).toBe('redis');
    expect(env.REDIS_BUILTIN).toBe('true');
    Object.assign(process.env, { REDIS_HOST: env.REDIS_HOST, REDIS_TLS: env.REDIS_TLS ?? '' });
    expect(redisConnectionOptions().tls).toBeUndefined();
  });

  it('keeps TLS for an external Redis configuration', () => {
    const env = write({ enabled: true, builtIn: false, host: 'cache.external.invalid' });
    Object.assign(process.env, { REDIS_HOST: env.REDIS_HOST, REDIS_TLS: env.REDIS_TLS });
    expect(redisConnectionOptions()).toMatchObject({ host: 'cache.external.invalid', tls: {} });
  });

  it('keeps TLS when an external host pin overrides a saved built-in choice', () => {
    process.env.REDIS_HOST = 'cache.external.invalid';
    process.env.REDIS_TLS = 'true';
    recordPinnedEnvKeys({ REDIS_HOST: 'cache.external.invalid', REDIS_TLS: 'true' });
    const env = write({ enabled: true, builtIn: true });
    expect(env.REDIS_TLS).toBe('true');
    expect(redisConnectionOptions()).toMatchObject({ host: 'cache.external.invalid', tls: {} });
  });
});

describe('InfraConfigController built-in Redis username', () => {
  const keys = [
    'REDIS_USERNAME',
    'REDIS_PASSWORD',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_TLS',
    'REDIS_ENABLED',
    'REDIS_BUILTIN',
    'QUEUE_ENABLED',
    'CACHE_ENABLED',
  ];
  let previous: Record<string, string | undefined>;
  const stored = (values: Record<string, string> = {}) =>
    Object.entries({
      DATABASE_TYPE: 'sqlite',
      STORAGE_TYPE: 'local',
      REDIS_ENABLED: 'true',
      REDIS_BUILTIN: 'false',
      REDIS_HOST: 'cache.external.invalid',
      REDIS_PORT: '6381',
      REDIS_USERNAME: 'worker',
      REDIS_PASSWORD: 'DummyRedisPassword123456',
      REDIS_TLS: 'false',
      QUEUE_ENABLED: 'false',
      CACHE_ENABLED: 'false',
      ...values,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n';

  beforeEach(() => {
    previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    recordOsEnvKeys({});
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(stored());
    (fs.writeFileSync as jest.Mock).mockClear();
  });
  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    recordOsEnvKeys({});
    recordPinnedEnvKeys({});
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
  });

  function write(redis: NonNullable<SaveConfigDto['redis']>): Record<string, string> {
    const controller = new InfraConfigController({} as never, {} as never, {} as never);
    expect(controller.saveConfig({ redis }).saved).toBe(true);
    return jest
      .requireActual<typeof import('dotenv')>('dotenv')
      .parse(jest.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string);
  }

  it('clears an old generated username when selecting the bundled Redis', () => {
    expect(write({ enabled: true, builtIn: true }).REDIS_USERNAME).toBeUndefined();
  });

  it.each(['host', 'project file'])('allows the default username from the %s', origin => {
    process.env.REDIS_USERNAME = 'default';
    recordOsEnvKeys(origin === 'host' ? { REDIS_USERNAME: 'default' } : {});
    recordPinnedEnvKeys({ REDIS_USERNAME: 'default' });
    expect(write({ enabled: true, builtIn: true }).REDIS_USERNAME).toBeUndefined();
  });

  it('keeps an external pinned username and the deliberate preset port/password behavior', () => {
    process.env.REDIS_HOST = 'cache.external.invalid';
    recordPinnedEnvKeys({ REDIS_HOST: process.env.REDIS_HOST });
    const saved = write({ enabled: true, builtIn: true });
    expect(saved.REDIS_USERNAME).toBe('worker');
    expect(saved.REDIS_PORT).toBe('6379');
    expect(saved.REDIS_PASSWORD).toBeUndefined();
  });

  it('accepts a named user for explicit external mode at the bundled host spelling', () => {
    expect(write({ enabled: true, builtIn: false, host: 'redis' }).REDIS_USERNAME).toBe('worker');
  });

  it('permits an inactive named username pin', () => {
    process.env.REDIS_USERNAME = 'worker';
    recordPinnedEnvKeys({ REDIS_USERNAME: 'worker' });
    (fs.readFileSync as jest.Mock).mockReturnValue(stored({ REDIS_ENABLED: 'false' }));
    expect(() => write({ enabled: false, builtIn: true })).not.toThrow();
  });
});
