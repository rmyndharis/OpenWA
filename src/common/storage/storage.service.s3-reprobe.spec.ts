import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { ConfigService } from '@nestjs/config';

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

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DEFAULT_S3_REPROBE_INTERVAL_MS,
  S3_DELETE_TIMEOUT_MS,
  S3_PROBE_TIMEOUT_MS,
  StorageService,
} from './storage.service';
import { sweepOrphanedFiles } from './orphan-sweep';
import * as transfer from './storage-transfer';

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

  function s3AvailableOf(svc: StorageService): boolean {
    return (svc as unknown as { s3Available: boolean }).s3Available;
  }

  it('falls back to local with a WARN when S3 is down at boot', async () => {
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();

    expect(s3AvailableOf(svc)).toBe(false);
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
    expect(s3AvailableOf(svc)).toBe(false);
  });

  it('recovers to S3 via the periodic probe (no dashboard poll) and stops probing afterwards', async () => {
    mockSend.mockRejectedValueOnce(s3Error('NetworkingError')); // boot probe fails
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();
    expect(s3AvailableOf(svc)).toBe(false);

    mockSend.mockResolvedValue({}); // S3 is back
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);

    expect(s3AvailableOf(svc)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovered'));

    // Timer stops after recovery: no further probes, and availability never flips back on its own.
    mockSend.mockClear();
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS * 5);
    expect(mockSend).not.toHaveBeenCalled();
    expect(s3AvailableOf(svc)).toBe(true);
  });

  it('creates the bucket on re-probe when the store was down at boot and came back empty', async () => {
    mockSend.mockRejectedValueOnce(s3Error('NetworkingError')); // boot probe: store not up yet
    const svc = new StorageService(makeConfig());
    warnSpyOf(svc);
    await flush();
    expect(s3AvailableOf(svc)).toBe(false);

    // The store is up now, but on a fresh volume: HeadBucket answers NotFound, CreateBucket succeeds.
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof HeadBucketCommand ? Promise.reject(s3Error('NotFound')) : Promise.resolve({}),
    );
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);

    expect(mockSend.mock.calls.some(([cmd]) => cmd instanceof CreateBucketCommand)).toBe(true);
    expect(s3AvailableOf(svc)).toBe(true);
  });

  it('treats losing a concurrent CreateBucket race (BucketAlreadyOwnedByYou) as the bucket being ready', async () => {
    mockSend.mockRejectedValueOnce(s3Error('NetworkingError'));
    const svc = new StorageService(makeConfig());
    warnSpyOf(svc);
    await flush();

    // Another replica created the bucket between this node's HeadBucket and its CreateBucket.
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.reject(s3Error(cmd instanceof HeadBucketCommand ? 'NotFound' : 'BucketAlreadyOwnedByYou')),
    );

    await expect(svc.refreshS3Availability()).resolves.toBe(true);
    expect(s3AvailableOf(svc)).toBe(true);
  });

  it('stays on the local fallback when the bucket name is owned by another account', async () => {
    mockSend.mockRejectedValueOnce(s3Error('NetworkingError'));
    const svc = new StorageService(makeConfig());
    warnSpyOf(svc);
    await flush();

    mockSend.mockImplementation((cmd: unknown) =>
      Promise.reject(s3Error(cmd instanceof HeadBucketCommand ? 'NotFound' : 'BucketAlreadyExists')),
    );

    await expect(svc.refreshS3Availability()).resolves.toBe(false);
    expect(s3AvailableOf(svc)).toBe(false);
  });

  it('stays on the local fallback when the re-probe cannot create the missing bucket, and says why', async () => {
    mockSend.mockRejectedValueOnce(s3Error('NetworkingError'));
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('NetworkingError'));

    mockSend.mockImplementation((cmd: unknown) =>
      Promise.reject(s3Error(cmd instanceof HeadBucketCommand ? 'NoSuchBucket' : 'AccessDenied')),
    );
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);

    expect(s3AvailableOf(svc)).toBe(false);
    // The store answered: the periodic warning names the refused create, not the boot-time outage.
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('AccessDenied'));
  });

  it('never transitions true→false: an S3-healthy boot ignores later transient probe failures', async () => {
    mockSend.mockResolvedValue({}); // boot probe succeeds
    const svc = new StorageService(makeConfig());
    await flush();
    expect(s3AvailableOf(svc)).toBe(true);

    mockSend.mockClear();
    mockSend.mockRejectedValue(s3Error('NetworkingError'));
    await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS * 3);

    expect(mockSend).not.toHaveBeenCalled(); // no re-probe of a healthy backend
    expect(s3AvailableOf(svc)).toBe(true);
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
    expect(s3AvailableOf(svc)).toBe(true);

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

  it('openFile streams the S3 body, with the object length as its size', async () => {
    const body = Readable.from([Buffer.from('from-s3')]);
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.resolve({ Body: body, ContentLength: 7 });
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    const { stream, size } = await svc.openFile('present.bin');
    expect(size).toBe(7);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('from-s3');
  });

  it('openFile reads a missing S3 object through from the local fallback dir, and rejects when neither has it', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.reject(s3Error('NoSuchKey'));
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();
    fs.writeFileSync(path.join(localPath, 'gap.bin'), 'gap-media');

    const { stream, size } = await svc.openFile('gap.bin');
    stream.destroy();
    expect(size).toBe(9);
    await expect(svc.openFile('missing.bin')).rejects.toThrow('NoSuchKey');
  });

  it('openFile surfaces the local error when the fallback copy exists but cannot be opened', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) return Promise.reject(s3Error('NoSuchKey'));
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();
    fs.writeFileSync(path.join(localPath, 'gap.bin'), 'gap-media');
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const openSpy = jest.spyOn(fs.promises, 'open').mockRejectedValueOnce(denied);

    try {
      await expect(svc.openFile('gap.bin')).rejects.toBe(denied);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('deleteFile removes the local fallback copy as well as the S3 object', async () => {
    mockSend.mockResolvedValue({}); // HeadBucket at boot, DeleteObject later
    const svc = new StorageService(makeConfig());
    await flush();
    expect(s3AvailableOf(svc)).toBe(true);

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

  it('deleteFile rejects once a DeleteObject that never settles hits its timeout', async () => {
    // A hung delete used to await forever, holding the retention purges' single-flight guard so no
    // purge ran again until a restart. The SDK's HTTP handler rejects when the abort signal fires.
    mockSend.mockImplementation((cmd: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (!(cmd instanceof DeleteObjectCommand)) return Promise.resolve({});
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(s3Error('AbortError')));
      });
    });
    // AbortSignal.timeout runs on Node's internal timers, which fake timers do not reach.
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const svc = new StorageService(makeConfig());
      await flush();

      const outcome = svc.deleteFile('hung.bin').then(
        () => 'resolved',
        (error: Error) => error.name,
      );
      await jest.advanceTimersByTimeAsync(S3_DELETE_TIMEOUT_MS - 1);
      await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe('AbortError');
    } finally {
      timeout.mockRestore();
    }
  });

  it('settles a bucket probe that never answers, so a later re-probe can still recover', async () => {
    // A probe that never settled stayed parked in the in-flight slot: every later re-probe and the
    // status and migration endpoints awaited it, and S3 never came back without a restart.
    let stalled: 'head' | 'create' | 'none' = 'head';
    mockSend.mockImplementation((cmd: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (stalled === 'create' && cmd instanceof HeadBucketCommand) return Promise.reject(s3Error('NotFound'));
      const stalls =
        (stalled === 'head' && cmd instanceof HeadBucketCommand) ||
        (stalled === 'create' && cmd instanceof CreateBucketCommand);
      if (!stalls) return Promise.resolve({});
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(s3Error('AbortError')));
      });
    });
    // AbortSignal.timeout runs on Node's internal timers, which fake timers do not reach.
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const settleWithin = async (probe: Promise<boolean>): Promise<boolean | 'pending'> => {
      await jest.advanceTimersByTimeAsync(S3_PROBE_TIMEOUT_MS);
      return Promise.race([probe, Promise.resolve('pending' as const)]);
    };
    try {
      const svc = new StorageService(makeConfig());
      warnSpyOf(svc);
      await flush();
      await jest.advanceTimersByTimeAsync(S3_PROBE_TIMEOUT_MS); // the boot probe gives up too
      expect(s3AvailableOf(svc)).toBe(false);

      await expect(settleWithin(svc.refreshS3Availability())).resolves.toBe(false);

      stalled = 'create';
      await expect(settleWithin(svc.refreshS3Availability())).resolves.toBe(false);

      stalled = 'none';
      await expect(settleWithin(svc.refreshS3Availability())).resolves.toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it('iterateFiles unions S3 objects with the local fallback dir (each key once)', async () => {
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

    const files: string[] = [];
    for await (const file of svc.iterateFiles()) files.push(file);
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

  // The count is the pre-check an operator runs before the export, so it must promise exactly the files the
  // archive will hold: not a console-made folder placeholder, and not a key the export cannot open.
  it('getFileCount counts the files the export carries, not folder placeholders or unsafe keys', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return Promise.resolve({
          Contents: [
            { Key: 'media/a.bin', Size: 1000 },
            { Key: 'media/sess1/', Size: 0 },
            { Key: 'media/sess1/b.bin', Size: 2000 },
            { Key: 'media/empty.bin', Size: 0 },
            { Key: 'media/../outside.bin', Size: 7 },
          ],
        });
      }
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    warnSpyOf(svc);
    await flush();
    fs.writeFileSync(path.join(localPath, 'local-only.bin'), Buffer.alloc(500));
    fs.writeFileSync(path.join(localPath, 'bad\u0001name.bin'), Buffer.alloc(9));
    const exported = jest.spyOn(transfer, 'createExportStream').mockResolvedValue(new PassThrough());

    const { count, sizeBytes } = await svc.getFileCount();
    await svc.createExportStream();
    const carried = await exported.mock.calls[0][0]();
    exported.mockRestore();

    expect(carried.sort()).toEqual(['empty.bin', 'local-only.bin', 'a.bin', 'sess1/b.bin'].sort());
    expect(count).toBe(carried.length);
    expect(sizeBytes).toBe(1000 + 2000 + 500);
  });

  // An S3 store is walked in two parts: the bucket, then the local fallback dir. A sweep only acts on the files it
  // is shown, so a directory it cannot read or a link in that fallback dir has to be skipped there as well, or
  // every pass aborts and reclaims nothing. The count and the export are the other way round and still refuse.
  it('the orphan sweep of an S3 store skips what it cannot read in the local fallback dir, which the count and the export refuse', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [{ Key: 'media/statuses/s3-only.bin', Size: 10 }] });
      }
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    const warn = warnSpyOf(svc);
    await flush();
    for (const file of ['statuses/local/readable.bin', 'statuses/locked/hidden.bin', 'elsewhere/behind.bin']) {
      fs.mkdirSync(path.dirname(path.join(localPath, file)), { recursive: true });
      fs.writeFileSync(path.join(localPath, file), 'x');
    }
    fs.symlinkSync(path.join(localPath, 'elsewhere'), path.join(localPath, 'statuses', 'linked'));
    // A mode-000 directory is still readable by root, so the failure is injected for the one path.
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    const readdirSpy = jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        String(target).endsWith(path.join('statuses', 'locked'))
          ? Promise.reject(Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' }))
          : readdir(target, ...rest)) as never);
    try {
      const deleteFile = jest.fn().mockResolvedValue(undefined);

      const removed = await sweepOrphanedFiles({
        storage: { iterateFiles: (prefix, options) => svc.iterateFiles(prefix, options), deleteFile },
        prefix: 'statuses/',
        graceMs: 0,
        now: 1000,
        firstSeenAt: new Map(),
        referencedAmong: () => Promise.resolve(new Set<string | undefined>()),
        onDeleteFailed: jest.fn(),
      });

      expect(removed).toBe(2);
      expect(deleteFile.mock.calls.map(([file]: [string]) => file).sort()).toEqual([
        'statuses/local/readable.bin',
        'statuses/s3-only.bin',
      ]);
      const skipped = warn.mock.calls.map(([line]: [string]) => line).join('\n');
      expect(skipped).toContain('"statuses/linked"');
      expect(skipped).toContain('"statuses/locked"');
      await expect(svc.getFileCount()).rejects.toThrow(/symbolic link.*statuses\/linked/);
      // The export refuses the same store: an archive that silently lacked those files would lose them.
      await expect(svc.createExportStream()).rejects.toThrow(/symbolic link.*statuses\/linked/);

      // With the link gone, the unreadable directory alone is refused by both.
      fs.unlinkSync(path.join(localPath, 'statuses', 'linked'));
      await expect(svc.getFileCount()).rejects.toThrow(/cannot be read.*statuses\/locked/);
      await expect(svc.createExportStream()).rejects.toThrow(/cannot be read.*statuses\/locked/);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('iterateFiles paginates S3 and unions the local fallback dir (each key once)', async () => {
    const pages = [
      { Contents: [{ Key: 'media/p1.bin' }], NextContinuationToken: 'tok' },
      { Contents: [{ Key: 'media/p2.bin' }] },
    ];
    const listCommand = ListObjectsV2Command as unknown as jest.Mock;
    listCommand.mockClear();
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) return Promise.resolve(pages.shift() ?? {});
      return Promise.resolve({});
    });
    const svc = new StorageService(makeConfig());
    await flush();

    fs.writeFileSync(path.join(localPath, 'local.bin'), 'x');
    // The stale local copy shares a page-1 key, so p2.bin can only come from following the token.
    fs.writeFileSync(path.join(localPath, 'p1.bin'), 'stale-copy');

    const seen: string[] = [];
    for await (const file of svc.iterateFiles()) seen.push(file);
    expect(seen.sort()).toEqual(['local.bin', 'p1.bin', 'p2.bin']);
    expect(listCommand.mock.calls.map(([input]: [{ ContinuationToken?: string }]) => input.ContinuationToken)).toEqual([
      undefined,
      'tok',
    ]);
  });

  it('syncs local fallback files written during transient S3 boot outage to S3 once S3 recovers', async () => {
    const uploaded = new Map<string, Buffer>();
    let healthy = false;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof HeadBucketCommand) {
        return healthy ? Promise.resolve({}) : Promise.reject(s3Error('NetworkingError'));
      }
      if (cmd instanceof PutObjectCommand) {
        const input = (cmd as { input?: { Key?: string; Body?: Buffer | Readable } }).input;
        if (input?.Key && input.Body) {
          if (Buffer.isBuffer(input.Body)) {
            uploaded.set(input.Key, Buffer.from(input.Body));
          } else {
            return (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of input.Body as AsyncIterable<Buffer | Uint8Array | string>) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              uploaded.set(input.Key!, Buffer.concat(chunks));
              return {};
            })();
          }
        }
        return Promise.resolve({});
      }
      if (cmd instanceof GetObjectCommand) {
        const key = (cmd as { input?: { Key?: string } }).input?.Key;
        const buf = key ? uploaded.get(key) : undefined;
        if (!buf) return Promise.reject(s3Error('NoSuchKey'));
        return Promise.resolve({ Body: Readable.from([buf]) });
      }
      return Promise.resolve({});
    });
    // Wire PutObjectCommand / GetObjectCommand mock constructors to capture `input` cleanly.
    const MockPut = PutObjectCommand as unknown as jest.Mock;
    MockPut.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });
    const MockGet = GetObjectCommand as unknown as jest.Mock;
    MockGet.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });

    try {
      const svc = new StorageService(makeConfig());
      await flush();
      expect(s3AvailableOf(svc)).toBe(false);

      const payload = Buffer.from('offline-media-bytes');
      await svc.putFile('sess-1/offline.png', payload);
      expect(fs.existsSync(path.join(localPath, 'sess-1/offline.png'))).toBe(true);
      expect(uploaded.has('sess-1/offline.png')).toBe(false);

      healthy = true;
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      await (svc as unknown as { fallbackSyncInFlight: Promise<void> | null }).fallbackSyncInFlight;

      expect(s3AvailableOf(svc)).toBe(true);
      const uploadedEntry = [...uploaded.entries()].find(([k]) => k.endsWith('sess-1/offline.png'));
      expect(uploadedEntry?.[1]?.equals(payload)).toBe(true);
      expect(fs.existsSync(path.join(localPath, 'sess-1/offline.png'))).toBe(false);
      await expect(svc.getFile('sess-1/offline.png')).resolves.toEqual(payload);

      // Streamed uploads route straight to S3 once recovered and enforce safe keys.
      await svc.putStream('sess-1/streamed.bin', Readable.from([Buffer.from('streamed-bytes')]), 14);
      await expect(svc.getFile('sess-1/streamed.bin')).resolves.toEqual(Buffer.from('streamed-bytes'));
      expect([...uploaded.keys()].some(k => k.endsWith('sess-1/streamed.bin'))).toBe(true);
      await expect(svc.putStream('../bad-key.bin', Readable.from([]), 0)).rejects.toThrow(
        'Refusing to store an unsafe storage key',
      );
      const failingStream = Readable.from([Buffer.from('fail-bytes')]);
      mockSend.mockRejectedValueOnce(s3Error('InternalError'));
      await expect(svc.putStream('sess-1/fail.bin', failingStream, 10)).rejects.toThrow('InternalError');
      expect(failingStream.destroyed).toBe(true);
      await svc.onModuleDestroy?.();
    } finally {
      MockPut.mockReset();
      MockGet.mockReset();
    }
  });

  it('serializes putFile, putStream, and deleteFile against active fallback sync without overwriting newer S3 writes or resurrecting deleted keys', async () => {
    const uploaded = new Map<string, Buffer>();
    let healthy = false;
    let releaseSyncUpload!: () => void;
    let firstSyncPutStarted!: () => void;
    const syncStarted = new Promise<void>(resolve => (firstSyncPutStarted = resolve));
    let gateFirstSyncPut = true;

    const MockPut = PutObjectCommand as unknown as jest.Mock;
    MockPut.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });
    const MockGet = GetObjectCommand as unknown as jest.Mock;
    MockGet.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });
    const MockDelete = DeleteObjectCommand as unknown as jest.Mock;
    MockDelete.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });

    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof HeadBucketCommand) {
        return healthy ? Promise.resolve({}) : Promise.reject(s3Error('NetworkingError'));
      }
      if (cmd instanceof PutObjectCommand) {
        const input = (cmd as { input?: { Key?: string; Body?: Buffer | Readable } }).input;
        return (async () => {
          const buf = Buffer.isBuffer(input?.Body)
            ? Buffer.from(input.Body)
            : await (async () => {
                const chunks: Buffer[] = [];
                for await (const c of input?.Body as AsyncIterable<Buffer | Uint8Array | string>) {
                  chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
                }
                return Buffer.concat(chunks);
              })();
          if (gateFirstSyncPut && input?.Key?.endsWith('sess-1/a-sync.bin')) {
            gateFirstSyncPut = false;
            firstSyncPutStarted();
            await new Promise<void>(resolve => (releaseSyncUpload = resolve));
          }
          if (input?.Key) uploaded.set(input.Key, buf);
          return {};
        })();
      }
      if (cmd instanceof GetObjectCommand) {
        const key = (cmd as { input?: { Key?: string } }).input?.Key;
        const buf = key ? uploaded.get(key) : undefined;
        if (!buf) return Promise.reject(s3Error('NoSuchKey'));
        return Promise.resolve({ Body: Readable.from([buf]) });
      }
      if (cmd instanceof DeleteObjectCommand) {
        const key = (cmd as { input?: { Key?: string } }).input?.Key;
        if (key) uploaded.delete(key);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    try {
      const svc = new StorageService(makeConfig());
      await flush();

      await svc.putFile('sess-1/a-sync.bin', Buffer.from('stale-a'));
      await svc.putFile('sess-1/b-put.bin', Buffer.from('stale-b'));
      await svc.putFile('sess-1/c-stream.bin', Buffer.from('stale-c'));
      await svc.putFile('sess-1/d-del.bin', Buffer.from('stale-d'));

      healthy = true;
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      jest.useRealTimers();
      await syncStarted;

      // While sync is paused on a-sync.bin, overwrite b-put & c-stream and delete d-del.
      const putB = svc.putFile('sess-1/b-put.bin', Buffer.from('fresh-b'));
      const putC = svc.putStream('sess-1/c-stream.bin', Readable.from([Buffer.from('fresh-c')]), 7);
      const delD = svc.deleteFile('sess-1/d-del.bin');

      await Promise.all([putB, putC, delD]);
      releaseSyncUpload();
      await svc.onModuleDestroy?.();

      const keyFor = (suffix: string) => [...uploaded.keys()].find(k => k.endsWith(suffix));
      expect(uploaded.get(keyFor('sess-1/a-sync.bin')!)?.toString()).toBe('stale-a');
      expect(uploaded.get(keyFor('sess-1/b-put.bin')!)?.toString()).toBe('fresh-b');
      expect(uploaded.get(keyFor('sess-1/c-stream.bin')!)?.toString()).toBe('fresh-c');
      expect(keyFor('sess-1/d-del.bin')).toBeUndefined();
      expect(fs.existsSync(path.join(localPath, 'sess-1/b-put.bin'))).toBe(false);
      expect(fs.existsSync(path.join(localPath, 'sess-1/c-stream.bin'))).toBe(false);
      expect(fs.existsSync(path.join(localPath, 'sess-1/d-del.bin'))).toBe(false);
    } finally {
      MockPut.mockReset();
      MockGet.mockReset();
      MockDelete.mockReset();
    }
  });

  it('retries partial transient fallback sync failures on the bounded retry timer and clears the timer on destroy', async () => {
    const uploaded = new Map<string, Buffer>();
    let healthy = false;
    let failFlakyOnce = true;

    const MockPut = PutObjectCommand as unknown as jest.Mock;
    MockPut.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });
    const MockGet = GetObjectCommand as unknown as jest.Mock;
    MockGet.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });

    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof HeadBucketCommand) {
        return healthy ? Promise.resolve({}) : Promise.reject(s3Error('NetworkingError'));
      }
      if (cmd instanceof PutObjectCommand) {
        const input = (cmd as { input?: { Key?: string; Body?: Buffer | Readable } }).input;
        if (failFlakyOnce && input?.Key?.endsWith('sess-1/flaky.bin')) {
          failFlakyOnce = false;
          return Promise.reject(s3Error('SlowDown'));
        }
        return (async () => {
          const buf = Buffer.isBuffer(input?.Body)
            ? Buffer.from(input.Body)
            : await (async () => {
                const chunks: Buffer[] = [];
                for await (const c of input?.Body as AsyncIterable<Buffer | Uint8Array | string>) {
                  chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
                }
                return Buffer.concat(chunks);
              })();
          if (input?.Key) uploaded.set(input.Key, buf);
          return {};
        })();
      }
      return Promise.resolve({});
    });

    try {
      const svc = new StorageService(makeConfig());
      await flush();

      await svc.putFile('sess-1/good.bin', Buffer.from('good-bytes'));
      await svc.putFile('sess-1/flaky.bin', Buffer.from('flaky-bytes'));

      healthy = true;
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      await (svc as unknown as { fallbackSyncInFlight: Promise<void> | null }).fallbackSyncInFlight;

      // good.bin synced, flaky.bin remains locally with retry timer armed.
      expect([...uploaded.keys()].some(k => k.endsWith('sess-1/good.bin'))).toBe(true);
      expect([...uploaded.keys()].some(k => k.endsWith('sess-1/flaky.bin'))).toBe(false);
      expect(fs.existsSync(path.join(localPath, 'sess-1/flaky.bin'))).toBe(true);
      expect((svc as unknown as { mayHaveLocalFallback: boolean }).mayHaveLocalFallback).toBe(true);
      expect(
        (svc as unknown as { fallbackSyncRetryTimer: NodeJS.Timeout | null }).fallbackSyncRetryTimer,
      ).not.toBeNull();

      // Next retry interval uploads flaky.bin and clears mayHaveLocalFallback.
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      await (svc as unknown as { fallbackSyncInFlight: Promise<void> | null }).fallbackSyncInFlight;

      expect([...uploaded.keys()].some(k => k.endsWith('sess-1/flaky.bin'))).toBe(true);
      expect(fs.existsSync(path.join(localPath, 'sess-1/flaky.bin'))).toBe(false);
      expect((svc as unknown as { mayHaveLocalFallback: boolean }).mayHaveLocalFallback).toBe(false);
      expect((svc as unknown as { fallbackSyncRetryTimer: NodeJS.Timeout | null }).fallbackSyncRetryTimer).toBeNull();
      await svc.onModuleDestroy?.();

      // Also verify onModuleDestroy clears an armed retry timer before it fires.
      failFlakyOnce = true;
      healthy = false;
      const svc2 = new StorageService(makeConfig());
      await flush();
      await svc2.putFile('sess-1/flaky.bin', Buffer.from('flaky-2'));
      healthy = true;
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      await (svc2 as unknown as { fallbackSyncInFlight: Promise<void> | null }).fallbackSyncInFlight;
      expect(
        (svc2 as unknown as { fallbackSyncRetryTimer: NodeJS.Timeout | null }).fallbackSyncRetryTimer,
      ).not.toBeNull();
      await svc2.onModuleDestroy?.();
      expect((svc2 as unknown as { fallbackSyncRetryTimer: NodeJS.Timeout | null }).fallbackSyncRetryTimer).toBeNull();
      mockSend.mockClear();
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS * 2);
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      MockPut.mockReset();
      MockGet.mockReset();
    }
  });

  it('keeps mayHaveLocalFallback armed and immediately resyncs late-finishing putFile and putStream fallback writes across S3 recovery', async () => {
    const uploaded = new Map<string, Buffer>();
    let healthy = false;
    let releaseBlockerUpload!: () => void;
    let blockerUploadStarted!: () => void;
    const blockerStartedP = new Promise<void>(resolve => (blockerUploadStarted = resolve));
    let gateBlocker = false;

    const MockPut = PutObjectCommand as unknown as jest.Mock;
    MockPut.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });
    const MockGet = GetObjectCommand as unknown as jest.Mock;
    MockGet.mockImplementation(function (this: { input: unknown }, input: unknown) {
      this.input = input;
    });

    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof HeadBucketCommand) {
        return healthy ? Promise.resolve({}) : Promise.reject(s3Error('NetworkingError'));
      }
      if (cmd instanceof PutObjectCommand) {
        const input = (cmd as { input?: { Key?: string; Body?: Buffer | Readable } }).input;
        return (async () => {
          const buf = Buffer.isBuffer(input?.Body)
            ? Buffer.from(input.Body)
            : await (async () => {
                const chunks: Buffer[] = [];
                for await (const c of input?.Body as AsyncIterable<Buffer | Uint8Array | string>) {
                  chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
                }
                return Buffer.concat(chunks);
              })();
          if (gateBlocker && input?.Key?.endsWith('sess-1/blocker.bin')) {
            gateBlocker = false;
            blockerUploadStarted();
            await new Promise<void>(resolve => (releaseBlockerUpload = resolve));
          }
          if (input?.Key) uploaded.set(input.Key, buf);
          return {};
        })();
      }
      if (cmd instanceof GetObjectCommand) {
        const key = (cmd as { input?: { Key?: string } }).input?.Key;
        const buf = key ? uploaded.get(key) : undefined;
        if (!buf) return Promise.reject(s3Error('NoSuchKey'));
        return Promise.resolve({ Body: Readable.from([buf]) });
      }
      return Promise.resolve({});
    });

    const realRealpath = fs.promises.realpath.bind(fs.promises);
    const drainSyncs = async (service: StorageService): Promise<void> => {
      for (;;) {
        const inflight = (service as unknown as { fallbackSyncInFlight: Promise<void> | null }).fallbackSyncInFlight;
        if (!inflight) break;
        await inflight;
      }
    };

    let realpathSpy: jest.SpyInstance | undefined;
    let realpathSpy2: jest.SpyInstance | undefined;

    try {
      // Case 1: putFile suspends mid-resolveLocalWriteTarget while initial empty sync finishes.
      const svc = new StorageService(makeConfig());
      await flush();

      let releasePutTarget!: () => void;
      let putTargetEntered!: () => void;
      const putTargetEnteredP = new Promise<void>(resolve => (putTargetEntered = resolve));
      let pauseFirstPut = true;
      realpathSpy = jest.spyOn(fs.promises, 'realpath').mockImplementation(async target => {
        if (pauseFirstPut && String(target).endsWith(path.join('media', 'sess-1'))) {
          pauseFirstPut = false;
          putTargetEntered();
          await new Promise<void>(resolve => (releasePutTarget = resolve));
        }
        return realRealpath(target);
      });

      const latePut = svc.putFile('sess-1/late-put.bin', Buffer.from('stale-put-v1'));
      await putTargetEnteredP;
      expect(fs.existsSync(path.join(localPath, 'sess-1/late-put.bin'))).toBe(false);

      healthy = true;
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      await drainSyncs(svc);
      expect((svc as unknown as { mayHaveLocalFallback: boolean }).mayHaveLocalFallback).toBe(true);
      expect([...uploaded.keys()].some(k => k.endsWith('sess-1/late-put.bin'))).toBe(false);

      releasePutTarget();
      await latePut;
      realpathSpy.mockRestore();

      // Immediate resync runs without advancing timers, uploads late-put, deletes local copy, and clears flag.
      await drainSyncs(svc);
      const putKey = [...uploaded.keys()].find(k => k.endsWith('sess-1/late-put.bin'));
      expect(putKey).toBeDefined();
      expect(uploaded.get(putKey!)?.toString()).toBe('stale-put-v1');
      expect(fs.existsSync(path.join(localPath, 'sess-1/late-put.bin'))).toBe(false);
      expect((svc as unknown as { mayHaveLocalFallback: boolean }).mayHaveLocalFallback).toBe(false);

      // Subsequent overwrite serves fresh bytes and leaves nothing on local disk.
      await svc.putFile('sess-1/late-put.bin', Buffer.from('fresh-put-v2'));
      expect((await svc.getFile('sess-1/late-put.bin')).toString()).toBe('fresh-put-v2');
      expect(fs.existsSync(path.join(localPath, 'sess-1/late-put.bin'))).toBe(false);
      await svc.onModuleDestroy?.();

      // Case 2: putStream finishes during an active sync pass (mid-enumeration/upload on another file).
      uploaded.clear();
      healthy = false;
      const svc2 = new StorageService(makeConfig());
      await flush();
      await svc2.putFile('sess-1/blocker.bin', Buffer.from('blocker'));

      let releaseStreamTarget!: () => void;
      let streamTargetEntered!: () => void;
      const streamTargetEnteredP = new Promise<void>(resolve => (streamTargetEntered = resolve));
      let pauseFirstStream = true;
      realpathSpy2 = jest.spyOn(fs.promises, 'realpath').mockImplementation(async target => {
        if (pauseFirstStream && String(target).endsWith(path.join('media', 'sub-stream'))) {
          pauseFirstStream = false;
          streamTargetEntered();
          await new Promise<void>(resolve => (releaseStreamTarget = resolve));
        }
        return realRealpath(target);
      });

      const lateStream = svc2.putStream(
        'sub-stream/late-stream.bin',
        Readable.from([Buffer.from('stale-stream-v1')]),
        15,
      );
      await streamTargetEnteredP;

      gateBlocker = true;
      healthy = true;
      await jest.advanceTimersByTimeAsync(DEFAULT_S3_REPROBE_INTERVAL_MS);
      await blockerStartedP;

      // Finish late putStream while sync pass #1 is active on blocker.bin.
      releaseStreamTarget();
      await lateStream;
      realpathSpy2.mockRestore();
      expect((svc2 as unknown as { localFallbackSyncPending: boolean }).localFallbackSyncPending).toBe(true);

      releaseBlockerUpload();
      await drainSyncs(svc2);

      const streamKey = [...uploaded.keys()].find(k => k.endsWith('sub-stream/late-stream.bin'));
      expect(streamKey).toBeDefined();
      expect(uploaded.get(streamKey!)?.toString()).toBe('stale-stream-v1');
      expect(fs.existsSync(path.join(localPath, 'sub-stream/late-stream.bin'))).toBe(false);
      expect((svc2 as unknown as { mayHaveLocalFallback: boolean }).mayHaveLocalFallback).toBe(false);

      await svc2.putStream('sub-stream/late-stream.bin', Readable.from([Buffer.from('fresh-stream-v2')]), 15);
      expect((await svc2.getFile('sub-stream/late-stream.bin')).toString()).toBe('fresh-stream-v2');
      await svc2.onModuleDestroy?.();
    } finally {
      realpathSpy?.mockRestore();
      realpathSpy2?.mockRestore();
      MockPut.mockReset();
      MockGet.mockReset();
    }
  });
});
