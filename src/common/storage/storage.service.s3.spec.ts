import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';

// `archiver` v8 ships ESM-only, which ts-jest can't parse transitively. These tests never touch the
// export path (archiver's only consumer), so a lightweight stub suffices — same approach as the local
// spec. Must run before importing StorageService.
jest.mock('archiver', () => ({ default: jest.fn() }));

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
  };
});

import { S3Client } from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

// The subset of the AWS SDK's S3Client config this service sets — used purely to type the mock's call
// args so the assertions below are type-checked instead of `any`.
type S3ClientConfig = {
  endpoint?: string;
  region: string;
  forcePathStyle?: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
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

    expect(mockedS3Client).toHaveBeenCalledTimes(1);
    const cfg = lastConfig();
    expect(cfg.endpoint).toBeUndefined(); // AWS derives it from region
    expect(cfg.forcePathStyle).toBeFalsy(); // AWS uses virtual-hosted addressing
    expect(cfg.region).toBe('ap-southeast-1');
    expect(cfg.credentials).toEqual({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shhh-secret' });
    expect(svc.isS3Available()).toBe(true);
  });

  it('keeps endpoint + forcePathStyle for an S3-compatible store (MinIO)', async () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    const svc = new StorageService(
      makeConfig({ accessKeyId: 'minio', secretAccessKey: 'minio123', region: 'us-east-1' }),
    );
    await flush();

    expect(mockedS3Client).toHaveBeenCalledTimes(1);
    const cfg = lastConfig();
    expect(cfg.endpoint).toBe('http://minio:9000');
    expect(cfg.forcePathStyle).toBe(true);
    expect(svc.isS3Available()).toBe(true);
  });

  it('falls back to local (no client) when credentials are missing', async () => {
    const svc = new StorageService(makeConfig({ region: 'us-east-1' }));
    await flush();

    expect(mockedS3Client).not.toHaveBeenCalled();
    expect(svc.isS3Available()).toBe(false);
    expect(svc.getCurrentStorageType()).toBe('s3');
  });

  it('prefers canonical env names (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY) over config', async () => {
    process.env.S3_ACCESS_KEY_ID = 'ENVKEY';
    process.env.S3_SECRET_ACCESS_KEY = 'ENVSECRET';
    const svc = new StorageService(
      makeConfig({ accessKeyId: 'CFGKEY', secretAccessKey: 'CFGSECRET', region: 'eu-west-1' }),
    );
    await flush();

    expect(lastConfig().credentials).toEqual({ accessKeyId: 'ENVKEY', secretAccessKey: 'ENVSECRET' });
    expect(svc.isS3Available()).toBe(true);
  });
});
