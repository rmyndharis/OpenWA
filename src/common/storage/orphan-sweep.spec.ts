import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import { sweepOrphanedFiles } from './orphan-sweep';
import { StorageService } from './storage.service';

describe('sweepOrphanedFiles', () => {
  const PREFIX = 'status/';

  function fixture(initial: string[]) {
    let keys = initial;
    const deleted: string[] = [];
    const deleteFile = jest.fn((key: string): Promise<void> => {
      deleted.push(key);
      return Promise.resolve();
    });
    const storage = {
      iterateFiles: async function* (): AsyncGenerator<string> {
        await Promise.resolve();
        for (const key of keys) yield key;
      },
      deleteFile,
    };
    return {
      deleted,
      deleteFile,
      set: (next: string[]) => {
        keys = next;
      },
      sweep: (
        overrides: Partial<Parameters<typeof sweepOrphanedFiles>[0]> & {
          firstSeenAt: Map<string, number>;
          now: number;
        },
      ) =>
        sweepOrphanedFiles({
          storage,
          prefix: PREFIX,
          graceMs: 500,
          referencedAmong: () => Promise.resolve(new Set<string | undefined>()),
          onDeleteFailed: jest.fn(),
          ...overrides,
        }),
    };
  }

  it('never touches a file outside the prefix it owns', async () => {
    const f = fixture(['status/a.jpg', 'chat-media/b.jpg']);
    const removed = await f.sweep({ firstSeenAt: new Map(), now: 1000, graceMs: 0 });
    expect(removed).toBe(1);
    expect(f.deleted).toEqual(['status/a.jpg']);
  });

  it('deletes an unreferenced file only after the grace window has run from its first sighting', async () => {
    const f = fixture(['status/a.jpg']);
    const firstSeenAt = new Map<string, number>();
    expect(await f.sweep({ firstSeenAt, now: 1000 })).toBe(0);
    expect(firstSeenAt.get('status/a.jpg')).toBe(1000);
    expect(await f.sweep({ firstSeenAt, now: 1499 })).toBe(0);
    expect(await f.sweep({ firstSeenAt, now: 1500 })).toBe(1);
    expect(f.deleted).toEqual(['status/a.jpg']);
    expect(firstSeenAt.size).toBe(0);
  });

  it('drops the bookkeeping of a file that disappeared or became referenced between passes', async () => {
    const f = fixture(['status/gone.jpg', 'status/claimed.jpg']);
    const firstSeenAt = new Map<string, number>();
    await f.sweep({ firstSeenAt, now: 1000 });
    expect([...firstSeenAt.keys()].sort()).toEqual(['status/claimed.jpg', 'status/gone.jpg']);

    f.set(['status/claimed.jpg']);
    await f.sweep({
      firstSeenAt,
      now: 1100,
      referencedAmong: () => Promise.resolve(new Set<string | undefined>(['status/claimed.jpg'])),
    });
    expect(firstSeenAt.size).toBe(0);
  });

  it('reports a failed delete and retries the file on a later pass', async () => {
    const f = fixture(['status/a.jpg']);
    f.deleteFile.mockRejectedValueOnce(new Error('EBUSY'));
    const onDeleteFailed = jest.fn();
    const firstSeenAt = new Map<string, number>();
    await f.sweep({ firstSeenAt, now: 1000, graceMs: 0, onDeleteFailed });
    expect(onDeleteFailed).toHaveBeenCalledWith('status/a.jpg', expect.any(Error));
    expect(firstSeenAt.has('status/a.jpg')).toBe(true);
    expect(await f.sweep({ firstSeenAt, now: 1001, graceMs: 0, onDeleteFailed })).toBe(1);
  });

  it('asks which keys are referenced in chunks of the size it was given', async () => {
    const f = fixture(['status/1', 'status/2', 'status/3', 'status/4', 'status/5']);
    const referencedAmong = jest.fn((keys: string[]) => {
      void keys;
      return Promise.resolve(new Set<string | undefined>());
    });
    await f.sweep({ firstSeenAt: new Map(), now: 1000, chunkSize: 2, referencedAmong });
    expect(referencedAmong.mock.calls.map(([keys]) => keys.length)).toEqual([2, 2, 1]);
  });
});

/**
 * The export and the file count refuse a store they cannot enumerate completely, because a short archive
 * would lose media on the next backend. A sweep has no such duty: it deletes only files it saw, so a
 * subtree it cannot read is merely left alone and must not stop it from reclaiming everything else.
 */
describe('sweepOrphanedFiles over a store with a directory it cannot read', () => {
  let baseDir: string;
  let storage: StorageService;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-sweep-'));
    const localPath = path.join(baseDir, 'media');
    for (const file of ['statuses/s1/orphan.bin', 'statuses/locked/hidden.bin', 'chat-media/s1/other.bin']) {
      fs.mkdirSync(path.dirname(path.join(localPath, file)), { recursive: true });
      fs.writeFileSync(path.join(localPath, file), 'x');
    }
    storage = new StorageService({
      get: (key: string) => ({ 'storage.type': 'local', 'storage.localPath': localPath })[key],
    } as unknown as ConfigService);
    // A mode-000 directory is still readable by root, so the failure is injected for that one path.
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        String(target).endsWith(path.join('statuses', 'locked'))
          ? Promise.reject(Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' }))
          : readdir(target, ...rest)) as never);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    storage.onModuleDestroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const sweep = (prefix: string) =>
    sweepOrphanedFiles({
      storage,
      prefix,
      graceMs: 0,
      now: 1000,
      firstSeenAt: new Map(),
      referencedAmong: () => Promise.resolve(new Set<string | undefined>()),
      onDeleteFailed: jest.fn(),
    });

  it('reclaims the orphans it can see and never touches the subtree it cannot', async () => {
    expect(await sweep('statuses/')).toBe(1);

    const present = (file: string): boolean => fs.existsSync(path.join(baseDir, 'media', file));
    expect(present('statuses/s1/orphan.bin')).toBe(false);
    expect(present('statuses/locked/hidden.bin')).toBe(true);
    expect(present('chat-media/s1/other.bin')).toBe(true);
    const warnings = (console.warn as jest.Mock).mock.calls.map(([line]) => String(line));
    expect(warnings.some(line => line.includes('statuses/locked'))).toBe(true);
  });

  it('keeps refusing a file count of the same store', async () => {
    await expect(storage.getFileCount()).rejects.toThrow(/EACCES/);
  });
});
