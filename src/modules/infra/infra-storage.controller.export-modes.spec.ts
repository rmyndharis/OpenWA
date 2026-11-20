import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import type { ConfigService } from '@nestjs/config';
import { LoggerService } from '../../common/services/logger.service';
import { StorageService } from '../../common/storage/storage.service';
import { InfraStorageController } from './infra-storage.controller';

/**
 * The export archive is a copy of every stored file, so it has to be as private as the local media store it copies:
 * an owner-only directory and file. These run on the real filesystem under a fixed umask, so an open default (0755
 * and 0644) fails them whatever umask the machine runs with.
 */
describe('InfraStorageController storage export modes', () => {
  let base: string;
  let previousUmask: number;
  const stores: StorageService[] = [];

  beforeEach(() => {
    previousUmask = process.umask(0o022);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-modes-'));
    // The export writes under <cwd>/data/exports.
    jest.spyOn(process, 'cwd').mockReturnValue(base);
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.onModuleDestroy();
    jest.restoreAllMocks();
    process.umask(previousUmask);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const exportsDir = (): string => path.join(base, 'data', 'exports');
  const modeOf = (target: string): string => (fs.statSync(target).mode & 0o777).toString(8);

  /** The real local store, as the image and a source install have it: data/ exists before the store starts. */
  const makeStore = (): StorageService => {
    fs.mkdirSync(path.join(base, 'data'), { mode: 0o755 });
    const localPath = path.join(base, 'data', 'media');
    const store = new StorageService({
      get: (key: string) => ({ 'storage.type': 'local', 'storage.localPath': localPath })[key],
    } as unknown as ConfigService);
    stores.push(store);
    return store;
  };

  /** Pretend an earlier version wrote the archive: a 0755 directory and a 0644 file, as the default modes gave. */
  const openUp = (archive: string): void => {
    fs.chmodSync(exportsDir(), 0o755);
    fs.chmodSync(archive, 0o644);
  };

  it.each(['local', 's3'])('writes the archive 0600 in a 0700 directory it creates (%s store)', async type => {
    const controller = new InfraStorageController({
      getCurrentStorageType: () => type,
      refreshS3Availability: () => Promise.resolve(true),
      createExportStream: () => Promise.resolve(Readable.from([Buffer.from('archive-bytes')])),
    } as never);

    const { download } = await controller.exportStorage();

    expect(modeOf(exportsDir())).toBe('700');
    expect(modeOf(path.join(base, download))).toBe('600');
  });

  it('is as private as the store it copies, and still imports back', async () => {
    const store = makeStore();
    await store.putFile('chat-media/session-a/photo.bin', Buffer.from('private photo bytes'));
    const controller = new InfraStorageController(store);

    const { download } = await controller.exportStorage();

    const mediaFile = path.join(base, 'data', 'media', 'chat-media/session-a/photo.bin');
    expect(modeOf(mediaFile)).toBe('600');
    expect(modeOf(path.join(base, download))).toBe('600');
    await store.deleteFile('chat-media/session-a/photo.bin');
    await expect(controller.importStorage({ filePath: download })).resolves.toMatchObject({ imported: true, count: 1 });
    expect((await store.getFile('chat-media/session-a/photo.bin')).toString()).toBe('private photo bytes');
  });

  it('tightens a directory an earlier version left 0755 when it exports again', async () => {
    const store = makeStore();
    await store.putFile('statuses/session-a/clip.bin', Buffer.from('clip'));
    const controller = new InfraStorageController(store);
    const first = path.join(base, (await controller.exportStorage()).download);
    openUp(first);

    const second = path.join(base, (await controller.exportStorage()).download);

    expect(modeOf(exportsDir())).toBe('700');
    expect(modeOf(second)).toBe('600');
    expect(modeOf(first)).toBe('644');
  });

  // The documented migration flow keeps the archive across a restart, so an archive written before an upgrade is
  // still there at the first boot of the new version.
  describe('at boot, over what an earlier version left', () => {
    const archiveName = (epochMs: number): string => `storage-export-${epochMs}-${randomUUID()}.tar.gz`;

    it('closes the directory, keeps a young archive and still imports it', async () => {
      const store = makeStore();
      await store.putFile('chat-media/session-a/photo.bin', Buffer.from('kept bytes'));
      const controller = new InfraStorageController(store);
      const { download } = await controller.exportStorage();
      const archive = path.join(base, download);
      openUp(archive);

      await controller.onApplicationBootstrap();

      expect(modeOf(exportsDir())).toBe('700');
      expect(modeOf(archive)).toBe('644');
      await store.deleteFile('chat-media/session-a/photo.bin');
      await expect(controller.importStorage({ filePath: download })).resolves.toMatchObject({ imported: true });
      expect((await store.getFile('chat-media/session-a/photo.bin')).toString()).toBe('kept bytes');
    });

    it('still sweeps an old archive it could not have written owner-only', async () => {
      fs.mkdirSync(exportsDir(), { recursive: true, mode: 0o755 });
      const stale = path.join(exportsDir(), archiveName(Date.now() - 48 * 60 * 60 * 1000));
      const young = path.join(exportsDir(), archiveName(Date.now()));
      for (const file of [stale, young]) {
        fs.writeFileSync(file, 'archive');
        fs.chmodSync(file, 0o644);
      }

      await new InfraStorageController({} as never).onApplicationBootstrap();

      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(young)).toBe(true);
      expect(modeOf(exportsDir())).toBe('700');
    });

    it('makes no directory when nothing was ever exported', async () => {
      await new InfraStorageController({} as never).onApplicationBootstrap();

      expect(fs.existsSync(exportsDir())).toBe(false);
    });
  });
});
