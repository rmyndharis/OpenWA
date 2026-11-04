import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';

// Mock the AWS SDK so no real network call is made: HeadBucket resolves (bucket reachable), and the
// S3Client constructor is a jest.fn so each test can assert on the exact config it received.
jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn().mockResolvedValue({});
  const S3Client = jest.fn().mockImplementation(() => ({ send }));
  return {
    S3Client,
    HeadBucketCommand: jest.fn(),
    CreateBucketCommand: jest.fn(),
    ListObjectsV2Command: jest.fn(),
    GetObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    DeleteObjectCommand: jest.fn(),
  };
});

import { S3Client } from '@aws-sdk/client-s3';
import { LoggerService } from '../services/logger.service';
import { S3_CONNECT_TIMEOUT_MS, S3_SOCKET_TIMEOUT_MS, StorageService } from './storage.service';

// The subset of the AWS SDK's S3Client config this service sets — used purely to type the mock's call
// args so the assertions below are type-checked instead of `any`.
type S3ClientConfig = {
  endpoint?: string;
  region: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  requestHandler?: { connectionTimeout?: number; socketTimeout?: number; requestTimeout?: number };
};

const mockedS3Client = S3Client as unknown as jest.Mock<unknown, [S3ClientConfig]>;

const ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
];

// initializeS3Bucket() runs as a fire-and-forget promise; let its HeadBucket settle before asserting.
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Whether the service currently routes to the bucket (the flag the boot probe and the re-probe set). */
const s3AvailableOf = (svc: StorageService): boolean => (svc as unknown as { s3Available: boolean }).s3Available;

/** The config passed to the most recent S3Client construction (throws if it was never constructed). */
function lastConfig(): S3ClientConfig {
  const last = mockedS3Client.mock.calls.at(-1);
  if (!last) throw new Error('S3Client was never constructed');
  return last[0];
}

describe('StorageService (s3) client init', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-'));
    mockedS3Client.mockClear();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    // The warning below is emitted from the constructor, so it can only be spied on the prototype.
    // `restoreMocks` is not set for this project, so an assertion that throws before an inline
    // restore would leave every later LoggerService in this file muted.
    jest.restoreAllMocks();
  });

  // Build a ConfigService scoped to s3 storage; localPath points at the per-test tmp dir so the
  // constructor's mkdir never touches the repo's ./data/media.
  function makeConfig(s3: Record<string, unknown>): ConfigService {
    return {
      get: (key: string) => {
        if (key === 'storage.type') return 's3';
        if (key === 'storage.localPath') return path.join(tmpRoot, 'media');
        if (key === 'storage.s3') return s3;
        return undefined;
      },
    } as unknown as ConfigService;
  }

  it('initializes for AWS S3 with credentials but NO endpoint (the #735 regression)', async () => {
    const svc = new StorageService(
      makeConfig({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shhh-secret', region: 'ap-southeast-1' }),
    );
    await flush();

    // One client for the store and one for the downloads openFile streams, built from the same config.
    expect(mockedS3Client).toHaveBeenCalledTimes(2);
    expect(mockedS3Client.mock.calls[1][0]).toEqual(mockedS3Client.mock.calls[0][0]);
    const cfg = lastConfig();
    expect(cfg.endpoint).toBeUndefined(); // AWS derives it from region
    expect(cfg.forcePathStyle).toBeFalsy(); // AWS uses virtual-hosted addressing
    expect(cfg.region).toBe('ap-southeast-1');
    expect(cfg.credentials).toEqual({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shhh-secret' });
    expect(s3AvailableOf(svc)).toBe(true);
  });

  it('keeps endpoint + forcePathStyle for an S3-compatible store (MinIO)', async () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    const svc = new StorageService(
      makeConfig({ accessKeyId: 'minio', secretAccessKey: 'minio123', region: 'us-east-1' }),
    );
    await flush();

    expect(mockedS3Client).toHaveBeenCalledTimes(2);
    expect(mockedS3Client.mock.calls[1][0]).toEqual(mockedS3Client.mock.calls[0][0]);
    const cfg = lastConfig();
    expect(cfg.endpoint).toBe('http://minio:9000');
    expect(cfg.forcePathStyle).toBe(true);
    expect(s3AvailableOf(svc)).toBe(true);
  });

  // A store that accepts the connection and never answers would otherwise leave every request (the
  // availability probe, media reads and archive writes) pending forever.
  it('bounds every request with a connect and an idle-socket timeout', async () => {
    new StorageService(makeConfig({ accessKeyId: 'minio', secretAccessKey: 'minio123', region: 'us-east-1' }));
    await flush();

    expect(mockedS3Client.mock.calls).toHaveLength(2);
    for (const [cfg] of mockedS3Client.mock.calls) {
      expect(cfg.requestHandler).toEqual({
        connectionTimeout: S3_CONNECT_TIMEOUT_MS,
        socketTimeout: S3_SOCKET_TIMEOUT_MS,
      });
    }
  });

  it('falls back to local (no client) when credentials are missing, and says so', async () => {
    // Without a client none of the S3 logging further down ever runs, so this fallback used to be
    // the one that produced no output at all: the bucket simply stayed empty. Name the two vars
    // that fix it, since that is the whole point of warning here.
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new StorageService(makeConfig({ region: 'us-east-1' }));
    await flush();

    expect(mockedS3Client).not.toHaveBeenCalled();
    expect(s3AvailableOf(svc)).toBe(false);
    expect(svc.getCurrentStorageType()).toBe('s3');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('S3_ACCESS_KEY_ID'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('S3_SECRET_ACCESS_KEY'));
  });

  it('names only the half of the credential pair that is missing', async () => {
    // Reaching the fallback with one of the pair set is a typo in the other. A warning that called
    // every credential absent would point the operator at the one they got right.
    process.env.S3_ACCESS_KEY_ID = 'ENVKEY';
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    new StorageService(makeConfig({ region: 'us-east-1' }));
    await flush();

    expect(mockedS3Client).not.toHaveBeenCalled();
    const message = String(warn.mock.calls.at(-1)?.[0]);
    expect(message).toContain('S3_SECRET_ACCESS_KEY');
    expect(message).not.toContain('S3_ACCESS_KEY_ID');
  });

  it('prefers canonical env names (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY) over config', async () => {
    process.env.S3_ACCESS_KEY_ID = 'ENVKEY';
    process.env.S3_SECRET_ACCESS_KEY = 'ENVSECRET';
    const svc = new StorageService(
      makeConfig({ accessKeyId: 'CFGKEY', secretAccessKey: 'CFGSECRET', region: 'eu-west-1' }),
    );
    await flush();

    expect(lastConfig().credentials).toEqual({ accessKeyId: 'ENVKEY', secretAccessKey: 'ENVSECRET' });
    expect(s3AvailableOf(svc)).toBe(true);
  });
});
