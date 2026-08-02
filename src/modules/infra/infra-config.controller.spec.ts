import * as fs from 'fs';

// StorageService (imported transitively by the infra controllers) pulls in `archiver`
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

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InfraConfigController } from './infra-config.controller';
import { SaveConfigDto } from './dto/save-config.dto';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { recordOsEnvKeys } from '../../config/env-precedence';

describe('InfraConfigController.saveConfig SSL reject-unauthorized', () => {
  function writtenEnv(config: unknown): string {
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const controller = new InfraConfigController({} as never, {} as never, {} as never);
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

describe('InfraConfigController PostgreSQL schema (POSTGRES_SCHEMA)', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

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

describe('InfraConfigController.saveConfig writes the generated env owner-only', () => {
  // data/.env.generated holds DB/S3/Redis credentials, so it must be written 0600 — not the
  // default 0644 (world-readable). The write must go through the same owner-only path the
  // first-run boot uses, closing the gap between a dashboard save and the next restart.
  it('persists data/.env.generated with mode 0600, not world-readable', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const controller = new InfraConfigController({} as never, {} as never, {} as never);
    controller.saveConfig({ database: { type: 'postgres', sslEnabled: true, password: 'pw' } } as never);
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

describe('InfraConfigController.saveConfig engine selection (persist ENGINE_TYPE — Infrastructure tile)', () => {
  const engineFactory = {
    getAvailableEngines: () => [{ id: 'whatsapp-web.js' }, { id: 'baileys' }],
  };
  const newController = () => new InfraConfigController(engineFactory as never, {} as never, {} as never);

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

describe('InfraConfigController.saveConfig built-in/external mode flips and the save-time secret guard', () => {
  const newController = () => new InfraConfigController({} as never, {} as never, {} as never);

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
describe('InfraConfigController C002 audit trail (light-dependency handlers)', () => {
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
      dockerService: { isDockerAvailable: () => false },
      shutdownService: { shutdown: jest.fn() },
    });
    await controller.requestRestart({ profiles: ['postgres'], profilesToRemove: [] });
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { profiles: string[] } }]>;
    expect(calls[0][0]).toBe(AuditAction.INFRA_RESTART_REQUESTED);
    expect(calls[0][1].metadata.profiles).toEqual(['postgres']);
  });
});
