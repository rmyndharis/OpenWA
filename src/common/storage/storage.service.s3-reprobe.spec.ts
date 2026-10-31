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
});
