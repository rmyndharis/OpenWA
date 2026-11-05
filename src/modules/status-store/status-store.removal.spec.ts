import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { StorageService } from '../../common/storage/storage.service';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';

const POSTER = '628111@c.us';
const media = { mimetype: 'image/jpeg', data: Buffer.from('jpeg bytes').toString('base64') };

const status = (waStatusId: string, withMedia = true) => ({
  waStatusId,
  contactJid: POSTER,
  type: withMedia ? ('image' as const) : ('text' as const),
  caption: waStatusId,
  postedAt: Date.now(),
  ...(withMedia ? { media } : {}),
});

describe('StatusStoreService.removeRevoked', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storage: StorageService;
  let service: StatusStoreService;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-removal-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    const values: Record<string, unknown> = {
      'storage.type': 'local',
      'storage.localPath': path.join(baseDir, 'media'),
    };
    const config = { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as unknown as ConfigService;
    storage = new StorageService(config);
    service = new StatusStoreService(repository, storage, config);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (ds.isInitialized) await ds.destroy();
    storage.onModuleDestroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const files = async (): Promise<string[]> => {
    const keys: string[] = [];
    for await (const key of storage.iterateFiles('statuses/')) keys.push(key);
    return keys;
  };

  it('removes the story and its file, and answers that it did', async () => {
    await service.ingest('s1', status('ST'));
    expect(await files()).toHaveLength(1);

    expect(await service.removeRevoked('s1', 'ST')).toBe(true);

    expect(await repository.count()).toBe(0);
    expect(await files()).toEqual([]);
    expect(await service.removeRevoked('s1', 'ST')).toBe(false);
  });

  it('removes a story that has no media', async () => {
    await service.ingest('s1', status('TXT', false));

    expect(await service.removeRevoked('s1', 'TXT')).toBe(true);

    expect(await repository.count()).toBe(0);
  });

  // The same contact's story reaches every session that has them as a contact, under one id.
  it('removes the story of one session and leaves the same story of another session', async () => {
    await service.ingest('s2', status('ST'));
    await service.ingest('s1', status('ST'));

    expect(await service.removeRevoked('s1', 'ST')).toBe(true);

    expect((await repository.find()).map(row => row.sessionId)).toEqual(['s2']);
    expect(await service.getMedia('s2', 'ST')).not.toBeNull();
    expect(await files()).toHaveLength(1);
  });

  // An undefined where value is dropped by TypeORM, so the lookup would match the first row of the session.
  it.each([[''], [undefined]])('removes nothing when the story id is %p', async id => {
    await service.ingest('s1', status('ST'));

    expect(await service.removeRevoked('s1', id as unknown as string)).toBe(false);
    expect(await service.removeRevoked('s1', id as unknown as string, { poster: POSTER })).toBe(false);

    expect(await repository.count()).toBe(1);
  });

  it('removes nothing for a sender it was told to hold the delete to when none is known', async () => {
    await service.ingest('s1', status('ST'));

    expect(await service.removeRevoked('s1', 'ST', {})).toBe(false);
    expect(await service.removeRevoked('s1', 'ST', { poster: '' })).toBe(false);

    expect(await repository.count()).toBe(1);
  });

  it('removes only a story of the poster it is held to', async () => {
    await service.ingest('s1', status('ST'));

    expect(await service.removeRevoked('s1', 'ST', { poster: '628999@c.us' })).toBe(false);
    expect(await repository.count()).toBe(1);
    expect(await service.removeRevoked('s1', 'ST', { poster: POSTER })).toBe(true);
    expect(await repository.count()).toBe(0);
  });

  // The row is the one thing readers see, so it goes first; a file that stays is the orphan sweep's.
  it('resolves, with the story gone, when its file cannot be deleted, and leaves the file to the orphan sweep', async () => {
    await service.ingest('s1', status('ST'));
    const deleteFile = storage.deleteFile.bind(storage);
    jest.spyOn(storage, 'deleteFile').mockRejectedValueOnce(new Error('EBUSY'));

    expect(await service.removeRevoked('s1', 'ST')).toBe(true);

    expect(await service.list('s1')).toEqual([]);
    expect(await files()).toHaveLength(1);
    // Seen unreferenced, then still so once the grace window has run, the file is reaped.
    const now = Date.now();
    jest.spyOn(storage, 'deleteFile').mockImplementation(deleteFile);
    expect(await service.sweepOrphanedMedia(now)).toBe(0);
    expect(await service.sweepOrphanedMedia(now + 2 * 60 * 60 * 1000)).toBe(1);
    expect(await files()).toEqual([]);
  });

  // The connect-time seed and the live message can ingest one story at once. A delete waits for both: one that
  // read the table before the other saved would otherwise save the story again after the delete removed it.
  it('removes a story that two ingests save one after the other', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    jest.spyOn(repository, 'findOne').mockImplementationOnce(() => gate.then(() => null));

    const slow = service.ingest('s1', status('ST', false)); // read the table first, and is still waiting for it
    const quick = service.ingest('s1', status('ST', false)); // reads, saves and is done
    const removal = service.removeRevoked('s1', 'ST');
    await quick;
    release();
    await Promise.all([slow, removal]);

    expect(await repository.count()).toBe(0);
  });

  it('does not wait for an ingest of another story', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    await service.ingest('s1', status('GONE', false));
    jest.spyOn(repository, 'findOne').mockImplementationOnce(() => gate.then(() => null));
    const other = service.ingest('s1', status('OTHER', false));

    expect(await service.removeRevoked('s1', 'GONE')).toBe(true);

    release();
    await other;
    expect((await repository.find()).map(row => row.waStatusId)).toEqual(['OTHER']);
  });

  it('stops waiting for an ingest that failed', async () => {
    jest.spyOn(repository, 'findOne').mockRejectedValueOnce(new Error('database is locked'));
    const failed = service.ingest('s1', status('ST', false));
    const removal = service.removeRevoked('s1', 'ST');

    await expect(failed).rejects.toThrow('database is locked');
    expect(await removal).toBe(false);
  });
});
