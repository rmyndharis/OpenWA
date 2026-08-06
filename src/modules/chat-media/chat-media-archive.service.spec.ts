import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

jest.mock('archiver', () => ({ default: jest.fn() }));

import { StorageService } from '../../common/storage/storage.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { ChatMediaArchiveService, CHAT_MEDIA_PREFIX } from './chat-media-archive.service';

/** A ConfigService stub that returns each call's default unless overridden by `overrides`. */
function fakeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => (key in overrides ? overrides[key] : defaultValue),
  } as unknown as ConfigService;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('ChatMediaArchiveService', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<Message>;
  let storageService: StorageService;

  /** Build a service whose archive flag / caps / TTL are set per-test. */
  const build = (overrides: Record<string, unknown> = {}): ChatMediaArchiveService =>
    new ChatMediaArchiveService(repository, storageService, fakeConfigService(overrides));

  const enabled = (overrides: Record<string, unknown> = {}): ChatMediaArchiveService =>
    build({ 'chatMedia.archiveEnabled': true, ...overrides });

  /** Persist a message row carrying the given inline media, as the projector would have. */
  async function saveRow(media?: Record<string, unknown>, over: Partial<Message> = {}): Promise<Message> {
    return repository.save(
      repository.create({
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        waMessageId: `wa-${Math.random().toString(36).slice(2)}`,
        from: '628111@c.us',
        to: 'me@c.us',
        body: '',
        type: 'image',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: 1,
        metadata: media ? { media } : undefined,
        ...over,
      }),
    );
  }

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-chat-media-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(Message);
    storageService = new StorageService(
      fakeConfigService({ 'storage.type': 'local', 'storage.localPath': path.join(baseDir, 'media') }),
    );
  });

  afterAll(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await repository.clear();
    for await (const file of storageService.iterateFiles('')) await storageService.deleteFile(file);
  });

  describe('archive', () => {
    it('writes the blob and points the row at it, under the chat-media prefix', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });

      const key = await enabled().archive(row);

      expect(key).toMatch(new RegExp(`^${CHAT_MEDIA_PREFIX}sess-1/[0-9a-f-]{36}\\.png$`));
      expect(await storageService.getFile(key!)).toEqual(PNG);
      const reloaded = await repository.findOneByOrFail({ id: row.id });
      expect(reloaded.mediaPath).toBe(key);
      expect(reloaded.mediaMimetype).toBe('image/png');
    });

    it('leaves the inline copy untouched — archiving is additive, not a move', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });

      await enabled().archive(row);

      const reloaded = await repository.findOneByOrFail({ id: row.id });
      expect((reloaded.metadata as { media: { data: string } }).media.data).toBe(base64);
    });

    it('does nothing at all while the archive flag is off', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });

      expect(await build().archive(row)).toBeNull();

      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
      const files = [];
      for await (const f of storageService.iterateFiles('')) files.push(f);
      expect(files).toEqual([]);
    });

    it.each([
      ['no media at all', undefined],
      ['media the engine omitted', { mimetype: 'image/png', omitted: true, sizeBytes: 10 }],
      ['media with no bytes', { mimetype: 'image/png' }],
      ['media with no declared mimetype', { data: 'AAAA' }],
    ])('skips %s', async (_label, media) => {
      const row = await saveRow(media);
      expect(await enabled().archive(row)).toBeNull();
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
    });

    it('skips media above the archive cap without touching the row', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });

      expect(await enabled({ 'chatMedia.maxBytes': 4 }).archive(row)).toBeNull();

      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
    });

    it('swallows a storage failure so the receive path is never affected', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const put = jest.spyOn(storageService, 'putFile').mockRejectedValueOnce(new Error('disk on fire'));

      await expect(enabled().archive(row)).resolves.toBeNull();

      expect(put).toHaveBeenCalled();
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
      put.mockRestore();
    });

    it('leaves the written file for the orphan sweep when the row update fails', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const update = jest.spyOn(repository, 'update').mockRejectedValueOnce(new Error('db gone'));

      await expect(enabled().archive(row)).resolves.toBeNull();

      // The file exists but no row references it — exactly the state sweepOrphanedMedia reaps.
      const files = [];
      for await (const f of storageService.iterateFiles(CHAT_MEDIA_PREFIX)) files.push(f);
      expect(files).toHaveLength(1);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
      update.mockRestore();
    });
  });

  describe('getMedia', () => {
    it('resolves an archived file by session + chat + WhatsApp message id', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const key = await enabled().archive(row);

      expect(await enabled().getMedia('sess-1', row.chatId, row.waMessageId)).toEqual({
        path: key,
        mimetype: 'image/png',
      });
    });

    it('returns null for a message with nothing archived', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      expect(await enabled().getMedia('sess-1', row.chatId, row.waMessageId)).toBeNull();
    });

    it('does not leak another session’s archived media', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await enabled().archive(row);

      expect(await enabled().getMedia('other-sess', row.chatId, row.waMessageId)).toBeNull();
    });
  });

  describe('purgeExpired', () => {
    /** Age a row past the retention window (@CreateDateColumn ignores writes on insert). */
    const backdate = (id: string, daysAgo: number): Promise<unknown> =>
      repository.query('UPDATE messages SET createdAt = ? WHERE id = ?', [
        new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        id,
      ]);

    it('keeps everything forever when the TTL is 0', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await enabled().archive(row);
      await backdate(row.id, 3650);

      expect(await enabled({ 'chatMedia.ttlDays': 0 }).purgeExpired(Date.now())).toBe(0);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeTruthy();
    });

    it('deletes the expired FILE and clears the columns, but keeps the message row', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const key = await enabled().archive(row);
      await backdate(row.id, 10);

      expect(await enabled({ 'chatMedia.ttlDays': 7 }).purgeExpired(Date.now())).toBe(1);

      await expect(storageService.getFile(key!)).rejects.toThrow();
      const reloaded = await repository.findOneByOrFail({ id: row.id });
      expect(reloaded.mediaPath).toBeNull();
      expect(reloaded.mediaMimetype).toBeNull();
      // The archive expiring must not take the message history with it.
      expect(reloaded.body).toBeDefined();
    });

    it('leaves a row inside the retention window alone', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await enabled().archive(row);
      await backdate(row.id, 2);

      expect(await enabled({ 'chatMedia.ttlDays': 7 }).purgeExpired(Date.now())).toBe(0);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeTruthy();
    });

    it('keeps the columns when the file delete fails, so the next sweep retries', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await enabled().archive(row);
      await backdate(row.id, 10);
      const del = jest.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(new Error('s3 down'));

      expect(await enabled({ 'chatMedia.ttlDays': 7 }).purgeExpired(Date.now())).toBe(0);

      // Clearing the columns here would strand the file until the orphan sweep's grace window.
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeTruthy();
      del.mockRestore();
    });
  });

  describe('purgeExpired batching (backlog safety)', () => {
    const backdate = (id: string, daysAgo: number): Promise<unknown> =>
      repository.query('UPDATE messages SET createdAt = ? WHERE id = ?', [
        new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        id,
      ]);

    /** Seed `n` archived+expired rows without paying for real base64 writes. */
    async function seedExpired(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        const row = await saveRow(undefined, {
          mediaPath: `${CHAT_MEDIA_PREFIX}sess-1/f${i}.png`,
          mediaMimetype: 'image/png',
        });
        await storageService.putFile(`${CHAT_MEDIA_PREFIX}sess-1/f${i}.png`, PNG);
        await backdate(row.id, 10);
      }
    }

    it('drains a backlog spanning many batches, and never exceeds the batch size in one statement', async () => {
      // The archive's default TTL is 0, so the first run after an operator sets a retention can
      // face an unbounded backlog. Unbatched, the single UPDATE ... WHERE id IN (...) blows past
      // the driver's bind-parameter ceiling AFTER the files are already deleted — the rows then
      // point at missing files forever, and every later tick fails the same way.
      await seedExpired(1250); // > 2 x PURGE_BATCH_SIZE (500)
      const svc = enabled({ 'chatMedia.ttlDays': 7 });
      const update = jest.spyOn(repository, 'update');

      expect(await svc.purgeExpired(Date.now())).toBe(1250);

      const biggest = Math.max(...update.mock.calls.map(c => (Array.isArray(c[0]) ? c[0].length : 1)));
      expect(biggest).toBeLessThanOrEqual(500);
      expect(update.mock.calls.length).toBeGreaterThan(1);
      expect(await repository.count({ where: { mediaPath: Not(IsNull()) } })).toBe(0);
      // The message rows themselves survive retention — only the archived blob expires.
      expect(await repository.count()).toBe(1250);
      update.mockRestore();
    });

    it('stops instead of spinning when every delete in a batch fails', async () => {
      await seedExpired(3);
      const del = jest.spyOn(storageService, 'deleteFile').mockRejectedValue(new Error('s3 down'));
      const svc = enabled({ 'chatMedia.ttlDays': 7 });

      expect(await svc.purgeExpired(Date.now())).toBe(0);

      // One batch attempted, not an endless re-select of the same undeletable rows.
      expect(del.mock.calls.length).toBe(3);
      expect(await repository.count({ where: { mediaPath: Not(IsNull()) } })).toBe(3);
      del.mockRestore();
    });
  });

  describe('sweepOrphanedMedia', () => {
    it('deletes an unreferenced file only after the grace window has passed', async () => {
      await storageService.putFile(`${CHAT_MEDIA_PREFIX}sess-1/orphan.png`, PNG);
      const svc = enabled({ 'chatMedia.orphanGraceMs': 1000 });
      const t0 = Date.now();

      expect(await svc.sweepOrphanedMedia(t0)).toBe(0); // first sighting only records first-seen
      expect(await svc.sweepOrphanedMedia(t0 + 500)).toBe(0); // still inside the grace window
      expect(await svc.sweepOrphanedMedia(t0 + 1500)).toBe(1);

      const files = [];
      for await (const f of storageService.iterateFiles(CHAT_MEDIA_PREFIX)) files.push(f);
      expect(files).toEqual([]);
    });

    it('never reaps a file a row still references, however long it sits there', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const key = await enabled().archive(row);
      const svc = enabled({ 'chatMedia.orphanGraceMs': 0 });

      expect(await svc.sweepOrphanedMedia(Date.now())).toBe(0);
      expect(await svc.sweepOrphanedMedia(Date.now() + 1_000_000)).toBe(0);
      expect(await storageService.getFile(key!)).toEqual(PNG);
    });

    it('reconciles in bounded chunks instead of loading the whole store into memory', async () => {
      // With the default TTL of 0 the archive grows without bound, so materialising every key AND
      // every archived row (as the first implementation did) turns the hourly sweep into a memory
      // spike proportional to the store. Each query must see only its own chunk of keys.
      for (let i = 0; i < 1200; i++) await storageService.putFile(`${CHAT_MEDIA_PREFIX}sess-1/o${i}.png`, PNG);
      const find = jest.spyOn(repository, 'find');
      const svc = enabled({ 'chatMedia.orphanGraceMs': 0 });

      expect(await svc.sweepOrphanedMedia(Date.now())).toBe(1200);

      expect(find.mock.calls.length).toBeGreaterThan(1);
      for (const [opts] of find.mock.calls) {
        const where = (opts as { where?: { mediaPath?: { _value?: unknown[] } } })?.where;
        const ids = where?.mediaPath?._value;
        // Every lookup is an IN over a bounded key list, never an unfiltered "all archived rows".
        expect(Array.isArray(ids)).toBe(true);
        expect((ids as unknown[]).length).toBeLessThanOrEqual(500);
      }
      find.mockRestore();
    });

    it('keeps referenced files across a chunk boundary', async () => {
      // A referenced file must survive even when it lands in a different chunk from its row.
      for (let i = 0; i < 600; i++) await storageService.putFile(`${CHAT_MEDIA_PREFIX}sess-1/p${i}.png`, PNG);
      const row = await saveRow(undefined, {
        mediaPath: `${CHAT_MEDIA_PREFIX}sess-1/p599.png`,
        mediaMimetype: 'image/png',
      });
      const svc = enabled({ 'chatMedia.orphanGraceMs': 0 });

      expect(await svc.sweepOrphanedMedia(Date.now())).toBe(599);
      expect(await storageService.getFile((await repository.findOneByOrFail({ id: row.id })).mediaPath!)).toEqual(PNG);
    });

    it('never touches status media — the two sweeps share one bucket', async () => {
      await storageService.putFile('statuses/sess-1/story.jpg', PNG);
      const svc = enabled({ 'chatMedia.orphanGraceMs': 0 });

      expect(await svc.sweepOrphanedMedia(Date.now())).toBe(0);
      expect(await svc.sweepOrphanedMedia(Date.now() + 1_000_000)).toBe(0);
      expect(await storageService.getFile('statuses/sess-1/story.jpg')).toEqual(PNG);
    });
  });

  describe('sweep scheduling', () => {
    it('schedules no timers while archiving is off', () => {
      const setInterval = jest.spyOn(global, 'setInterval');
      const svc = build();

      svc.onModuleInit();

      // With the archive off no row can hold a mediaPath, so both sweeps would be recurring
      // no-op walks of a store they must never touch.
      expect(setInterval).not.toHaveBeenCalled();
      svc.onModuleDestroy();
      setInterval.mockRestore();
    });

    it('schedules both sweeps once archiving is on, and clears them on destroy', () => {
      const setInterval = jest.spyOn(global, 'setInterval');
      const clearInterval = jest.spyOn(global, 'clearInterval');
      const svc = enabled();

      svc.onModuleInit();
      expect(setInterval).toHaveBeenCalledTimes(2);

      svc.onModuleDestroy();
      expect(clearInterval).toHaveBeenCalledTimes(2);
      setInterval.mockRestore();
      clearInterval.mockRestore();
    });
  });
});
