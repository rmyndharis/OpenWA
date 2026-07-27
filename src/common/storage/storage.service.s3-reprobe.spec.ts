import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';

// `archiver` v8 ships ESM-only, which ts-jest can't parse transitively. These tests never touch the
// export path (archiver's only consumer), so a lightweight stub suffices — same approach as the
// other storage specs. Must run before importing StorageService.
jest.mock('archiver', () => ({ default: jest.fn() }));

// Mock the AWS SDK so no real network call is made. Each test drives `mockSend`: HeadBucket probes
// (boot + re-probe) and GetObject reads are distinguished by the mocked command constructors.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const S3Client = jest.fn().mockImplementation(() => ({ send: mockSend }));
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

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DEFAULT_S3_REPROBE_INTERVAL_MS, StorageService } from './storage.service';

const ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_REPROBE_INTERVAL_MS',
];

/** Let fire-and-forget promises (boot HeadBucket, timer-tick probes) settle before asserting. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function s3Error(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe('StorageService S3 re-probe and recovery', () => {
  let tmpRoot: string;
  let localPath: string;

  beforeEach(() => {
    jest.useFakeTimers();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-reprobe-'));
    localPath = path.join(tmpRoot, 'media');
    mockSend.mockReset();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeConfig(): ConfigService {
    return {
      get: (key: string) => {
        if (key === 'storage.type') return 's3';
        if (key === 'storage.localPath') return localPath;
        if (key === 'storage.s3') return { accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1' };
        return undefined;
      },
    } as unknown as ConfigService;
  }

  function warnSpyOf(svc: StorageService): jest.SpyInstance {
    const logger = (svc as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger;
    return jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  }

  it('falls back to local with a WARN when S3 is down at boot', async () => {
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();

    expect(svc.isS3Available()).toBe(false);
    expect(svc.getCurrentStorageType()).toBe('s3');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('degraded'));
  });

  it('keeps WARNing once per re-probe interval while S3 stays down (rate-limited by the interval)', async () => {
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1); // boot fallback

    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(svc.isS3Available()).toBe(false);
  });

  it('recovers to S3 via the periodic probe (no dashboard poll) and stops probing afterwards', async () => {
    mockSend.mockRejectedValueOnce(s3Error('NetworkingError')); // boot probe fails
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();
    expect(svc.isS3Available()).toBe(false);

    mockSend.mockResolvedValue({}); // S3 is back
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);

    expect(svc.isS3Available()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovered'));

    // Timer stops after recovery: no further probes, and availability never flips back on its own.
    mockSend.mockClear();
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS * 5);
    expect(mockSend).not.toHaveBeenCalled();
    expect(svc.isS3Available()).toBe(true);
  });

  it('never transitions true→false: an S3-healthy boot ignores later transient probe failures', async () => {
    mockSend.mockResolvedValue({}); // boot probe succeeds
    const svc = new StorageService(makeConfig());
    await flush();
    expect(svc.isS3Available()).toBe(true);

    mockSend.mockClear();
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS * 3);

    expect(mockSend).not.toHaveBeenCalled(); // no re-probe of a healthy backend
    expect(svc.isS3Available()).toBe(true);
  });

  it('honors S3_REPROBE_INTERVAL_MS for the periodic probe', async () => {
    process.env.S3_REPROBE_INTERVAL_MS = '5000';
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    new StorageService(makeConfig());
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1); // boot HeadBucket

    await jest.advanceTimersByTimeAsync(4999);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSend).toHaveBeenCalledTimes(2); // first scheduled re-probe
  });

  it('uses the 60s default when S3_REPROBE_INTERVAL_MS is unset or garbage', async () => {
    process.env.S3_REPROBE_INTERVAL_MS = 'not-a-number';
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    new StorageService(makeConfig());
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS - 1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('reads a missing S3 object through from the local fallback dir (media written during the outage)', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.reject(s3Error('NoSuchKey'));
      return Promise.resolve({}); // HeadBucket etc.
    });
    const svc = new StorageService(makeConfig());
    await flush();
    expect(svc.isS3Available()).toBe(true);

    // Simulate gap media: written to the local fallback dir while S3 was down, never uploaded.
    fs.mkdirSync(path.join(localPath, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(localPath, 'sub/gap.bin'), 'gap-media');

    const data = await svc.getFile('sub/gap.bin');
    expect(data.toString()).toBe('gap-media');
  });

  it('surfaces the original NoSuchKey when neither S3 nor the local fallback has the object', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.reject(s3Error('NoSuchKey'));
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    await expect(svc.getFile('missing.bin')).rejects.toThrow('NoSuchKey');
  });

  it('does not read through on non-NoSuchKey S3 errors', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.reject(s3Error('AccessDenied'));
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();
    fs.writeFileSync(path.join(localPath, 'secret.bin'), 'local-copy');

    await expect(svc.getFile('secret.bin')).rejects.toThrow('AccessDenied');
  });

  it('still serves objects straight from S3 when they exist there', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.resolve({ Body: Readable.from([Buffer.from('from-s3')]) });
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    const data = await svc.getFile('present.bin');
    expect(data.toString()).toBe('from-s3');
  });

  it('deleteFile removes the local fallback copy as well as the S3 object', async () => {
    mockSend.mockResolvedValue({}); // HeadBucket at boot, DeleteObject later
    const svc = new StorageService(makeConfig());
    await flush();
    expect(svc.isS3Available()).toBe(true);

    // Gap media: written to the local fallback dir while S3 was down, never uploaded. Without the
    // delete-through, deleting the (missing) S3 key would leave these bytes orphaned forever.
    fs.writeFileSync(path.join(localPath, 'gap.bin'), 'gap-media');

    await svc.deleteFile('gap.bin');

    expect(fs.existsSync(path.join(localPath, 'gap.bin'))).toBe(false);
    const deleteCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof DeleteObjectCommand);
    expect(deleteCalls.length).toBe(1);
  });

  it('deleteFile still resolves for an S3-only key (no local copy — ENOENT stays success)', async () => {
    mockSend.mockResolvedValue({});
    const svc = new StorageService(makeConfig());
    await flush();

    await expect(svc.deleteFile('s3-only.bin')).resolves.toBeUndefined();
    const deleteCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof DeleteObjectCommand);
    expect(deleteCalls.length).toBe(1);
  });

  it('listFiles unions S3 objects with the local fallback dir (each key once)', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [{ Key: 'media/s3-only.bin' }, { Key: 'media/shared.bin' }] });
      }
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    fs.writeFileSync(path.join(localPath, 'local-only.bin'), 'x');
    fs.writeFileSync(path.join(localPath, 'shared.bin'), 'stale-local-copy');

    const files = await svc.listFiles();
    expect(files.sort()).toEqual(['local-only.bin', 's3-only.bin', 'shared.bin']);
  });

  it('getFileCount counts local-only fallback files S3 does not know about', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return Promise.resolve({
          Contents: [
            { Key: 'media/s3.bin', Size: 1000 },
            { Key: 'media/shared.bin', Size: 10 },
          ],
        });
      }
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    fs.writeFileSync(path.join(localPath, 'local.bin'), Buffer.alloc(500));
    fs.writeFileSync(path.join(localPath, 'shared.bin'), Buffer.alloc(99999)); // S3 size wins for a shared key

    const result = await svc.getFileCount();
    expect(result.count).toBe(3);
    expect(result.sizeBytes).toBe(1000 + 10 + 500);
  });

  it('iterateFiles paginates S3 and unions the local fallback dir (each key once)', async () => {
    const pages = [
      { Contents: [{ Key: 'media/p1.bin' }], NextContinuationToken: 'tok' },
      { Contents: [{ Key: 'media/p2.bin' }] },
    ];
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) return Promise.resolve(pages.shift() ?? {});
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    fs.writeFileSync(path.join(localPath, 'local.bin'), 'x');
    fs.writeFileSync(path.join(localPath, 'p2.bin'), 'stale-copy');

    const seen: string[] = [];
    for await (const file of svc.iterateFiles()) seen.push(file);
    expect(seen.sort()).toEqual(['local.bin', 'p1.bin', 'p2.bin']);
  });
});
