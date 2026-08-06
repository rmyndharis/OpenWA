import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DeepPartial, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

jest.mock('archiver', () => ({ default: jest.fn() }));

import { StorageService } from '../../common/storage/storage.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';

/** A ConfigService stub that returns each call's default unless overridden by `overrides`. */
function fakeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => (key in overrides ? overrides[key] : defaultValue),
  } as unknown as ConfigService;
}

function makeStorageService(localPath: string): StorageService {
  return new StorageService(fakeConfigService({ 'storage.type': 'local', 'storage.localPath': localPath }));
}

describe('StatusStoreService (ingest / list / getMedia)', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;
  let service: StatusStoreService;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-store-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
    service = new StatusStoreService(repository, storageService, fakeConfigService());
  });

  afterAll(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('ingest writes a text row with expiresAt = postedAt + 24h, flagged as created', async () => {
    const postedAt = Date.now();
    const { row, created } = await service.ingest('sess', {
      waStatusId: 'w1',
      contactJid: '628111@c.us',
      type: 'text',
      caption: 'hi',
      postedAt,
    });
    expect(created).toBe(true);
    expect(row.expiresAt).toBe(postedAt + 24 * 60 * 60 * 1000);
    expect(row.mediaOmitted).toBe(false);
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest persists text-status styling and serves it back in the API shape', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'styled',
      contactJid: '628111@c.us',
      type: 'text',
      caption: 'hi',
      backgroundColor: '#25d366',
      font: 2,
      postedAt: Date.now(),
    });
    expect(row.backgroundColor).toBe('#25d366');
    expect(row.font).toBe(2);

    const styled = (await service.list('sess')).find(s => s.id === 'styled')!;
    expect(styled.backgroundColor).toBe('#25d366');
    expect(styled.font).toBe(2);
  });

  it('ingest persists media to a file under the cap and records mediaPath', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'w2',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('x').toString('base64') },
      postedAt: Date.now(),
    });
    expect(row.mediaPath).toBeTruthy();
    expect(row.mediaMimetype).toBe('image/jpeg');
    expect(row.mediaOmitted).toBe(false);
    expect(row.mediaPath!.endsWith('.jpg')).toBe(true);
    // The file was actually written under the storage root.
    expect(fs.readFileSync(path.join(baseDir, 'media', row.mediaPath!), 'utf8')).toBe('x');
  });

  it('ingest marks media omitted when the engine already omitted it', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'w3',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', omitted: true, sizeBytes: 99 },
      postedAt: Date.now(),
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('engine_omitted');
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest marks media omitted when sizeBytes exceeds STATUS_MEDIA_MAX_BYTES', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'w4',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: '...', sizeBytes: 999_999_999 },
      postedAt: Date.now(),
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('over_cap');
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest records over_cap (not engine_omitted) when an engine-skipped blob exceeds the store cap', async () => {
    // The seed's pre-gate skips downloads above the store cap with the engine-omitted flag set —
    // the durable reason must still read over_cap on both arrival paths.
    const { row } = await service.ingest('sess', {
      waStatusId: 'w8',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', omitted: true, sizeBytes: 11 * 1024 * 1024 },
      postedAt: Date.now(),
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('over_cap');
  });

  it('ingest is idempotent on (sessionId, waStatusId), flagged as not created on the duplicate', async () => {
    await service.ingest('sess', { waStatusId: 'dup', contactJid: '628111@c.us', type: 'text', postedAt: 1 });
    const second = await service.ingest('sess', {
      waStatusId: 'dup',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: 1,
    });
    const rows = await repository.find({ where: { sessionId: 'sess', waStatusId: 'dup' } });
    expect(rows).toHaveLength(1);
    expect(second.row.id).toBe(rows[0].id);
    expect(second.created).toBe(false);
  });

  it('list maps rows to the Status shape newest-first, media path -> mediaUrl endpoint', async () => {
    const out = await service.list('sess');
    expect(out[0].contact.id).toBe('628111@c.us');
    expect(out[0].timestamp).toBeInstanceOf(Date);
    expect(out[0].expiresAt).toBeInstanceOf(Date);
    // Sorted newest (highest postedAt) first.
    const postedOrder = out.map(s => s.timestamp.getTime());
    expect(postedOrder).toEqual([...postedOrder].sort((a, b) => b - a));

    const withMedia = out.find(s => s.id === 'w2')!;
    expect(withMedia.mediaUrl).toBe('/api/sessions/sess/status/w2/media');
    const omitted = out.find(s => s.id === 'w3')!;
    expect(omitted.mediaUrl).toBeUndefined();
    const textOnly = out.find(s => s.id === 'w1')!;
    expect(textOnly.mediaUrl).toBeUndefined();
  });

  it('list and listByContact exclude already-expired rows (the purge sweep only runs every 15 min)', async () => {
    await service.ingest('sess', {
      waStatusId: 'stale',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h old — past the 24h TTL
    });
    expect((await service.list('sess')).map(s => s.id)).not.toContain('stale');
    expect((await service.listByContact('sess', '628111@c.us')).map(s => s.id)).not.toContain('stale');
  });

  it('getMedia treats an expired row as absent (404, matching "not found or expired")', async () => {
    await service.ingest('sess', {
      waStatusId: 'stale-media',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('old').toString('base64') },
      postedAt: Date.now() - 25 * 60 * 60 * 1000,
    });
    expect(await service.getMedia('sess', 'stale-media')).toBeNull();
  });

  it('listByContact filters to only that contact', async () => {
    await service.ingest('sess', { waStatusId: 'w5', contactJid: '628222@c.us', type: 'text', postedAt: Date.now() });
    const out = await service.listByContact('sess', '628222@c.us');
    expect(out).toHaveLength(1);
    expect(out[0].contact.id).toBe('628222@c.us');
  });

  it('getMedia returns the path/mimetype for a status with kept media', async () => {
    const media = await service.getMedia('sess', 'w2');
    expect(media?.mimetype).toBe('image/jpeg');
    expect(media?.path).toContain('statuses/sess/');
  });

  it('getMedia returns null for an omitted-media status', async () => {
    expect(await service.getMedia('sess', 'w3')).toBeNull();
  });

  it('getMedia returns null for a text-only status', async () => {
    expect(await service.getMedia('sess', 'w1')).toBeNull();
  });

  it('getMedia returns null for an unknown status id', async () => {
    expect(await service.getMedia('sess', 'nope')).toBeNull();
  });

  it('ingest marks media write_failed when the storage backend throws', async () => {
    const failingStorage = {
      putFile: jest.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as StorageService;
    const failingService = new StatusStoreService(repository, failingStorage, fakeConfigService());
    const { row } = await failingService.ingest('sess', {
      waStatusId: 'w6',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('y').toString('base64') },
      postedAt: 7000,
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('write_failed');
    expect(row.mediaPath).toBeFalsy();
  });

  it('names the reason when the file lands but the row update fails (webhook must not see a bare omission)', async () => {
    // The in-memory row returned here is exactly what dispatchStatusReceived sends. Every other
    // omission path sets omitReason, so leaving it unset made a real media loss indistinguishable
    // from an unexplained omission — and nothing retries it.
    const saveSpy = jest.spyOn(repository, 'save');
    let calls = 0;
    saveSpy.mockImplementation((row: DeepPartial<StatusUpdate>) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('db blip')); // the post-write update
      return Promise.resolve(row as DeepPartial<StatusUpdate> & StatusUpdate);
    });
    try {
      const { row } = await service.ingest('sess', {
        waStatusId: 'w-row-fail',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('q').toString('base64') },
        postedAt: 9100,
      });
      expect(row.mediaOmitted).toBe(true);
      expect(row.omitReason).toBe('write_failed');
      expect(row.mediaPath).toBeFalsy();
    } finally {
      saveSpy.mockRestore();
    }
  });

  it('respects a configured status.mediaMaxBytes cap', async () => {
    const strictService = new StatusStoreService(
      repository,
      storageService,
      fakeConfigService({ 'status.mediaMaxBytes': 0 }),
    );
    const { row } = await strictService.ingest('sess', {
      waStatusId: 'w7',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/png', data: Buffer.from('z').toString('base64') },
      postedAt: 8000,
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('over_cap');
  });
});

describe('StatusStoreService ingest race (unique-constraint loser)', () => {
  let baseDir: string;
  let storageService: StorageService;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-race-'));
    storageService = makeStorageService(path.join(baseDir, 'media'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const mediaDir = (): string[] => {
    const dir = path.join(baseDir, 'media', 'statuses', 'sess');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('never writes a media file when a concurrent ingest wins the unique constraint (row-first)', async () => {
    // The winner committed its own media file; with row-first ordering the loser has not written
    // anything at the point its save fails, so there is nothing to reap and no second file.
    fs.mkdirSync(path.join(baseDir, 'media', 'statuses', 'sess'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'media', 'statuses', 'sess', 'winner.jpg'), 'winner');
    const winner = new StatusUpdate();
    winner.mediaPath = 'statuses/sess/winner.jpg';
    // First findOne (top of ingest) sees nothing; the post-save-failure re-read returns the winner.
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      save: jest.fn().mockRejectedValue(new Error('UNIQUE constraint failed')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    const { row, created } = await service.ingest('sess', {
      waStatusId: 'raced',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('loser').toString('base64') },
      postedAt: 1000,
    });

    expect(row).toBe(winner);
    expect(created).toBe(false);
    expect(mediaDir()).toEqual(['winner.jpg']);
  });

  it('writes no file when the row save fails with no winner row, then rethrows', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockRejectedValue(new Error('database is locked')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    await expect(
      service.ingest('sess', {
        waStatusId: 'raced',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('loser').toString('base64') },
        postedAt: 1000,
      }),
    ).rejects.toThrow('database is locked');

    // Row-first: the save precedes any file write, so a failed save can never leak an orphan.
    expect(mediaDir()).toHaveLength(0);
  });

  it('rethrows a non-unique save error even when the commit landed, leaving no orphan file behind', async () => {
    // The pathological "driver errored on a commit that landed" case: the re-read finds a row, but
    // the failure is genuine (not a unique violation) and must surface. The landed row carries no
    // media reference (the file write comes after the save), so the state stays consistent.
    const landed = new StatusUpdate();
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(landed),
      save: jest.fn().mockRejectedValue(new Error('driver reported failure after commit')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    await expect(
      service.ingest('sess', {
        waStatusId: 'raced',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('self').toString('base64') },
        postedAt: 1000,
      }),
    ).rejects.toThrow('driver reported failure after commit');

    expect(mediaDir()).toHaveLength(0);
  });

  it('rethrows a non-unique save error even when a coincidental winner row exists', async () => {
    fs.mkdirSync(path.join(baseDir, 'media', 'statuses', 'sess'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'media', 'statuses', 'sess', 'winner.jpg'), 'winner');
    const winner = new StatusUpdate();
    winner.mediaPath = 'statuses/sess/winner.jpg';
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      save: jest.fn().mockRejectedValue(new Error('database is locked')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    // A genuine persistence failure must not be swallowed into an idempotent return just because
    // a matching row happens to exist — and this call never wrote a file to begin with.
    await expect(
      service.ingest('sess', {
        waStatusId: 'raced',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('loser').toString('base64') },
        postedAt: 1000,
      }),
    ).rejects.toThrow('database is locked');

    expect(mediaDir()).toEqual(['winner.jpg']);
  });
});

describe('StatusStoreService contact identity (read-time lid resolution)', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-lid-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const lidStore = (mappings: Record<string, string | null>): LidMappingStoreService =>
    ({
      getCached: (lid: string) => (lid in mappings ? mappings[lid] : undefined),
      lidsForPhone: (phone: string) =>
        Object.entries(mappings)
          .filter(([, p]) => p === phone)
          .map(([l]) => l),
    }) as unknown as LidMappingStoreService;

  it('resolves a @lid contact to the mapped phone at read time, so both forms group together', async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '111': '628111' }));
    const now = Date.now();
    await svc.ingest('sess', { waStatusId: 'l1', contactJid: '111@lid', type: 'text', postedAt: now });
    await svc.ingest('sess', { waStatusId: 'l2', contactJid: '628111@c.us', type: 'text', postedAt: now + 1 });

    const contacts = new Set((await svc.list('sess')).map(s => s.contact.id));
    expect(contacts).toEqual(new Set(['628111@c.us']));
  });

  it('leaves unknown and known-unresolved lids untouched', async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '222': null }));
    const now = Date.now();
    await svc.ingest('sess', { waStatusId: 'u1', contactJid: '222@lid', type: 'text', postedAt: now });
    await svc.ingest('sess', { waStatusId: 'u2', contactJid: '333@lid', type: 'text', postedAt: now + 1 });

    const contacts = (await svc.list('sess')).map(s => s.contact.id);
    expect(contacts).toContain('222@lid');
    expect(contacts).toContain('333@lid');
  });

  it("listByContact matches rows stored under the contact's lid when queried by phone", async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '111': '628111' }));
    await svc.ingest('sess', { waStatusId: 'l3', contactJid: '111@lid', type: 'text', postedAt: Date.now() });

    const out = await svc.listByContact('sess', '628111@c.us');
    expect(out).toHaveLength(1);
    expect(out[0].contact.id).toBe('628111@c.us');
  });

  it("listByContact forward-resolves a lid query to rows stored under the contact's phone", async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '111': '628111' }));
    await svc.ingest('sess', { waStatusId: 'l4', contactJid: '628111@c.us', type: 'text', postedAt: Date.now() });

    const out = await svc.listByContact('sess', '111@lid');
    expect(out).toHaveLength(1);
    expect(out[0].contact.id).toBe('628111@c.us');
  });

  it('never resolves phone-shaped JIDs through the lid map (digit-collision guard)', async () => {
    // A lid key colliding with a phone's digits must not rename a phone-form row.
    const svc = new StatusStoreService(
      repository,
      storageService,
      fakeConfigService(),
      lidStore({ '628111': '628999' }),
    );
    await svc.ingest('sess', { waStatusId: 'l5', contactJid: '628111@c.us', type: 'text', postedAt: Date.now() });

    const out = await svc.list('sess');
    expect(out[0].contact.id).toBe('628111@c.us');
  });
});

describe('StatusStoreService.purgeExpired', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;
  let service: StatusStoreService;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-purge-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
    service = new StatusStoreService(repository, storageService, fakeConfigService());
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const ingestWithMedia = async (waStatusId: string, postedAt: number): Promise<StatusUpdate> =>
    (
      await service.ingest('sess', {
        waStatusId,
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from(waStatusId).toString('base64') },
        postedAt,
      })
    ).row;

  it('deletes expired rows and their media files, keeps live ones', async () => {
    const expiredWithMedia = await ingestWithMedia('expired-media', 1000);
    await service.ingest('sess', {
      waStatusId: 'expired-text',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: 2000,
    });
    const live = await ingestWithMedia('live-media', Date.now());

    const mediaFile = path.join(baseDir, 'media', expiredWithMedia.mediaPath!);
    expect(fs.existsSync(mediaFile)).toBe(true);

    const now = 2000 + 24 * 60 * 60 * 1000 + 1; // after both 1000/2000-posted rows expire, before `live`
    const removed = await service.purgeExpired(now);

    expect(removed).toBe(2);
    expect(fs.existsSync(mediaFile)).toBe(false);
    const remaining = await repository.find();
    expect(remaining.map(r => r.waStatusId)).toEqual(['live-media']);
    expect(fs.existsSync(path.join(baseDir, 'media', live.mediaPath!))).toBe(true);
  });

  it('returns 0 and touches nothing when no rows are expired', async () => {
    await ingestWithMedia('live', Date.now());
    const removed = await service.purgeExpired(0);
    expect(removed).toBe(0);
    expect(await repository.count()).toBe(1);
  });

  it('keeps a row whose media delete failed (retried next sweep), still purging the rest', async () => {
    const expiredWithMedia = await ingestWithMedia('expired-media', 1000);
    await service.ingest('sess', {
      waStatusId: 'expired-text',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: 2000,
    });
    const mediaFile = path.join(baseDir, 'media', expiredWithMedia.mediaPath!);

    // A backend outage fails the file delete: the row must survive (deleting it would orphan the
    // file permanently), while the file-less text row is still purged.
    const failingStorage = {
      deleteFile: jest.fn().mockRejectedValue(new Error('backend down')),
    } as unknown as StorageService;
    const failingService = new StatusStoreService(repository, failingStorage, fakeConfigService());

    const now = 2000 + 24 * 60 * 60 * 1000 + 1;
    const removed = await failingService.purgeExpired(now);

    expect(removed).toBe(1); // only the text row (no file to delete)
    const remaining = await repository.find();
    expect(remaining.map(r => r.waStatusId)).toEqual(['expired-media']);
    expect(fs.existsSync(mediaFile)).toBe(true);

    // The next sweep, with a healthy backend, finishes the job.
    const retried = await service.purgeExpired(now);
    expect(retried).toBe(1);
    expect(await repository.count()).toBe(0);
    expect(fs.existsSync(mediaFile)).toBe(false);
  });

  it('returns 0 without throwing when every expired row keeps its row (all media deletes fail)', async () => {
    const a = await ingestWithMedia('expired-a', 1000);
    const b = await ingestWithMedia('expired-b', 2000);

    // Every expired row has a media file and every delete fails, so nothing is deletable — an
    // unguarded delete([]) would throw TypeORM's empty-criteria error instead of returning 0.
    const failingStorage = {
      deleteFile: jest.fn().mockRejectedValue(new Error('backend down')),
    } as unknown as StorageService;
    const failingService = new StatusStoreService(repository, failingStorage, fakeConfigService());

    const now = 2000 + 24 * 60 * 60 * 1000 + 1;
    await expect(failingService.purgeExpired(now)).resolves.toBe(0);

    // Rows and files all survive for the next sweep's retry.
    const remaining = await repository.find();
    expect(remaining.map(r => r.waStatusId).sort()).toEqual(['expired-a', 'expired-b']);
    expect(fs.existsSync(path.join(baseDir, 'media', a.mediaPath!))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'media', b.mediaPath!))).toBe(true);
  });
});

describe('StatusStoreService.sweepOrphanedMedia', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;
  let service: StatusStoreService;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-sweep-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
    service = new StatusStoreService(repository, storageService, fakeConfigService());
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const ingestWithMedia = async (waStatusId: string, postedAt: number): Promise<StatusUpdate> =>
    (
      await service.ingest('sess', {
        waStatusId,
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from(waStatusId).toString('base64') },
        postedAt,
      })
    ).row;

  const writeFile = (key: string, contents: string): void => {
    const full = path.join(baseDir, 'media', key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  };

  it('reaps an orphan only after the grace window; never touches referenced or non-status files', async () => {
    const live = await ingestWithMedia('live', Date.now());
    const liveFile = path.join(baseDir, 'media', live.mediaPath!);
    // A file with no referencing row — the crash-between-write-and-row-update leftover.
    writeFile('statuses/sess/orphan.jpg', 'orphan');
    // Chat media shares the store; the sweep is scoped to the statuses/ prefix.
    writeFile('chat/sess/keep.jpg', 'keep');

    const t0 = Date.now();
    // First sighting only records the orphan; inside the grace window nothing is deleted.
    expect(await service.sweepOrphanedMedia(t0)).toBe(0);
    expect(await service.sweepOrphanedMedia(t0 + 30 * 60 * 1000)).toBe(0);
    expect(fs.existsSync(path.join(baseDir, 'media', 'statuses', 'sess', 'orphan.jpg'))).toBe(true);

    // Past the grace window (default 1h) the orphan is reaped; referenced and non-status files stay.
    expect(await service.sweepOrphanedMedia(t0 + 61 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'media', 'statuses', 'sess', 'orphan.jpg'))).toBe(false);
    expect(fs.existsSync(liveFile)).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'media', 'chat', 'sess', 'keep.jpg'))).toBe(true);
  });

  it('never reaps a file that becomes referenced between sightings', async () => {
    // First pass sees the file while its row update has not landed yet (the ingest crash window).
    writeFile('statuses/sess/pending.jpg', 'pending');
    const t0 = Date.now();
    expect(await service.sweepOrphanedMedia(t0)).toBe(0);

    // The row update lands, now referencing the file.
    const row = new StatusUpdate();
    row.sessionId = 'sess';
    row.contactJid = '628111@c.us';
    row.waStatusId = 'late-reference';
    row.type = 'image';
    row.postedAt = t0;
    row.expiresAt = t0 + 24 * 60 * 60 * 1000;
    row.mediaPath = 'statuses/sess/pending.jpg';
    row.mediaMimetype = 'image/jpeg';
    row.mediaOmitted = false;
    await repository.save(row);

    // Even past the grace window the file is safe — the referenced check re-reads the rows.
    expect(await service.sweepOrphanedMedia(t0 + 61 * 60 * 1000)).toBe(0);
    expect(fs.existsSync(path.join(baseDir, 'media', 'statuses', 'sess', 'pending.jpg'))).toBe(true);
  });

  it('honors a configured status.orphanGraceMs override', async () => {
    const shortGrace = new StatusStoreService(
      repository,
      storageService,
      fakeConfigService({ 'status.orphanGraceMs': 1000 }),
    );
    writeFile('statuses/sess/orphan.jpg', 'orphan');

    const t0 = Date.now();
    expect(await shortGrace.sweepOrphanedMedia(t0)).toBe(0);
    expect(await shortGrace.sweepOrphanedMedia(t0 + 1001)).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'media', 'statuses', 'sess', 'orphan.jpg'))).toBe(false);
  });

  it('enumerates past the listFiles() cap so orphans beyond it are still reaped', async () => {
    // listFiles() truncates at STORAGE_LIST_MAX_FILES (a per-call DoS guard, not a completeness
    // contract); the sweep reconciles against the FULL store, so it streams iterateFiles() instead.
    process.env.STORAGE_LIST_MAX_FILES = '5';
    try {
      for (let i = 0; i < 8; i++) writeFile(`statuses/sess/orphan-${i}.jpg`, 'orphan');
      // The capped call the sweep used to make would see only 5 of the 8 orphans.
      expect((await storageService.listFiles()).filter(f => f.startsWith('statuses/'))).toHaveLength(5);

      const t0 = Date.now();
      expect(await service.sweepOrphanedMedia(t0)).toBe(0); // first sighting starts the grace clock
      expect(await service.sweepOrphanedMedia(t0 + 61 * 60 * 1000)).toBe(8); // all 8, not the capped 5
      expect(fs.readdirSync(path.join(baseDir, 'media', 'statuses', 'sess'))).toHaveLength(0);
    } finally {
      delete process.env.STORAGE_LIST_MAX_FILES;
    }
  });
});

describe('StatusStoreService onModuleInit/onModuleDestroy (sweep scheduling)', () => {
  const mockDeps = (): { repo: Repository<StatusUpdate>; storage: StorageService; find: jest.Mock } => {
    const find = jest.fn().mockResolvedValue([]);
    const repo = { find } as unknown as Repository<StatusUpdate>;
    const storage = { iterateFiles: jest.fn().mockReturnValue([]) } as unknown as StorageService;
    return { repo, storage, find };
  };

  it('purges once at startup and schedules a recurring sweep, cleared on destroy', () => {
    const { repo, storage } = mockDeps();
    const service = new StatusStoreService(repo, storage, fakeConfigService());

    jest.useFakeTimers();
    try {
      const purgeSpy = jest.spyOn(service, 'purgeExpired').mockResolvedValue(0);
      service.onModuleInit();
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      purgeSpy.mockClear();
      jest.advanceTimersByTime(15 * 60 * 1000);
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      purgeSpy.mockClear();
      jest.advanceTimersByTime(15 * 60 * 1000);
      expect(purgeSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs the orphan sweep once at startup and on its own (slower) cadence, cleared on destroy', () => {
    const { repo, storage } = mockDeps();
    const service = new StatusStoreService(repo, storage, fakeConfigService());

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(service, 'sweepOrphanedMedia').mockResolvedValue(0);
      service.onModuleInit();
      expect(sweepSpy).toHaveBeenCalledTimes(1);

      // The TTL purge fires every 15 min; the orphan sweep only on its own 1h interval.
      sweepSpy.mockClear();
      jest.advanceTimersByTime(15 * 60 * 1000);
      expect(sweepSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(45 * 60 * 1000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      sweepSpy.mockClear();
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(sweepSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('honors a configured status.orphanSweepIntervalMs override', () => {
    const { repo, storage } = mockDeps();
    const service = new StatusStoreService(
      repo,
      storage,
      fakeConfigService({ 'status.orphanSweepIntervalMs': 5 * 60 * 1000 }),
    );

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(service, 'sweepOrphanedMedia').mockResolvedValue(0);
      service.onModuleInit();
      sweepSpy.mockClear();
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
