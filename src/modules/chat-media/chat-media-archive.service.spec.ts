import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { StorageService } from '../../common/storage/storage.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { ChatMediaArchiveService, CHAT_MEDIA_PREFIX } from './chat-media-archive.service';
import { MessageMutationProjector } from '../session/message-mutation-projector';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { MessageSendService } from '../message/message-send.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { updateMessageMetadata } from '../message/message-metadata';

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
    jest.restoreAllMocks();
    await repository.clear();
    for await (const file of storageService.iterateFiles('')) await storageService.deleteFile(file);
  });

  describe('archive', () => {
    it('updates null metadata and never restores metadata after a concurrent revoke', async () => {
      const row = await saveRow();
      expect(await updateMessageMetadata(repository, { id: row.id }, () => ({ keep: 1 }))).toEqual({ keep: 1 });
      const update = repository.update.bind(repository);
      jest.spyOn(repository, 'update').mockImplementationOnce(async (where, patch) => {
        await update({ id: row.id }, { type: 'revoked', metadata: {} });
        return update(where, patch);
      });
      expect(await updateMessageMetadata(repository, { id: row.id }, current => ({ ...current, stale: 1 }))).toBeNull();
      expect((await repository.findOneByOrFail({ id: row.id })).metadata).toEqual({});
    });

    it('bounds metadata retries when another writer wins every update', async () => {
      const row = await saveRow();
      const update = jest.spyOn(repository, 'update').mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });
      await expect(updateMessageMetadata(repository, { id: row.id }, () => ({ keep: 1 }))).rejects.toThrow(
        'Message metadata changed repeatedly',
      );
      expect(update).toHaveBeenCalledTimes(3);
      expect((await repository.findOneByOrFail({ id: row.id })).metadata).toBeNull();
    });
    it('enforces the byte cap even when supplied sizeBytes is too small', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64'), sizeBytes: 1 });
      expect(await enabled({ 'chatMedia.maxBytes': 1 }).archive(row)).toBeNull();
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
    });
    it.each(['bulk', 'single'])('keeps an archived echo when the %s send writer merges later', async mode => {
      const media = { mimetype: 'image/png', data: PNG.toString('base64') };
      const row = await saveRow(media, { direction: MessageDirection.OUTGOING });
      await enabled({ 'chatMedia.inlineMode': 'archive' }).archive(row);
      const engines = new EngineRegistry();
      engines.set('sess-1', {
        sendImageMessage: () => Promise.resolve({ id: row.waMessageId, timestamp: 1 }),
      } as never);
      const sender = new MessageSendService(
        repository,
        { findOne: () => Promise.resolve({ phone: '628111' }) } as never,
        engines,
        { execute: (_event: string, data: unknown) => Promise.resolve({ continue: true, data }) } as never,
        {} as never,
        { assertSendAllowed: () => Promise.resolve(), recordSendSuccess: () => undefined } as never,
        fakeConfigService({ 'features.simulateTyping': false }),
      );
      if (mode === 'bulk') {
        await sender.saveOutgoingMessage('sess-1', {
          waMessageId: row.waMessageId,
          chatId: row.chatId,
          type: 'image',
          status: MessageStatus.SENT,
          metadata: { media },
        });
      } else {
        await sender.sendImage('sess-1', { chatId: row.chatId, base64: media.data, mimetype: media.mimetype });
      }
      const stored = await repository.findOneByOrFail({ id: row.id });
      expect(stored.mediaPath).toBeTruthy();
      expect(stored.metadata).toEqual({
        media: { mimetype: 'image/png', omitted: true, archived: true, sizeBytes: PNG.length },
      });
      expect(await repository.count()).toBe(1);
    });

    it('keeps archived media when a reaction read preceded archive publication', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const archive = enabled({ 'chatMedia.inlineMode': 'archive' });
      const update = repository.update.bind(repository);
      let published = false;
      jest.spyOn(repository, 'update').mockImplementation(async (where, patch) => {
        if (patch.metadata && !published) {
          published = true;
          await archive.archive(row);
        }
        return update(where, patch);
      });
      const mutations = new KeyedMutationQueue();
      const projector = new MessageMutationProjector(
        repository,
        { emitMessageReaction: jest.fn() } as never,
        { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
        mutations,
        { error: jest.fn() } as never,
      );
      projector.applyReactionQueued('sess-1', {
        messageId: row.waMessageId,
        chatId: row.chatId,
        senderId: '628111@c.us',
        reaction: 'ok',
      });
      while (mutations.size) await new Promise(resolve => setImmediate(resolve));
      const stored = await repository.findOneByOrFail({ id: row.id });
      expect(stored.mediaPath).toBeTruthy();
      expect(stored.metadata).toEqual({
        media: { mimetype: 'image/png', omitted: true, archived: true, sizeBytes: PNG.length },
        reactions: { '628111@c.us': 'ok' },
      });
    });

    it.each(['bulk', 'single'])('preserves sent bytes after a failed %s echo merge', async mode => {
      const row = await saveRow(undefined, { direction: MessageDirection.OUTGOING });
      const engines = new EngineRegistry();
      engines.set('sess-1', {
        sendImageMessage: () => Promise.resolve({ id: row.waMessageId, timestamp: 1 }),
      } as never);
      const sender = new MessageSendService(
        repository,
        { findOne: () => Promise.resolve({ phone: '628111' }) } as never,
        engines,
        { execute: (_event: string, data: unknown) => Promise.resolve({ continue: true, data }) } as never,
        {} as never,
        { assertSendAllowed: () => Promise.resolve(), recordSendSuccess: () => undefined } as never,
        fakeConfigService({ 'features.simulateTyping': false }),
      );
      const update = repository.update.bind(repository);
      let mergeFailed = false;
      jest.spyOn(repository, 'update').mockImplementation((where, patch) => {
        if (!mergeFailed && patch.metadata && typeof where === 'object' && where !== null && 'waMessageId' in where) {
          mergeFailed = true;
          return Promise.reject(new Error('SQLITE_BUSY'));
        }
        return update(where, patch);
      });
      const media = { mimetype: 'image/png', data: PNG.toString('base64') };
      if (mode === 'bulk') {
        await sender.saveOutgoingMessage('sess-1', {
          waMessageId: row.waMessageId,
          chatId: row.chatId,
          type: 'image',
          status: MessageStatus.SENT,
          metadata: { media },
        });
      } else {
        await sender.sendImage('sess-1', { chatId: row.chatId, base64: media.data, mimetype: media.mimetype });
      }
      expect(mergeFailed).toBe(true);
      const retained = await repository.findOneByOrFail({ sessionId: 'sess-1', waMessageId: IsNull() });
      expect(retained.status).toBe(MessageStatus.SENT);
      expect(retained.metadata.media).toEqual(media);
      expect(await repository.count()).toBe(2);
      expect(await enabled({ 'chatMedia.inlineMode': 'archive' }).archive(retained)).toBeNull();
      expect((await repository.findOneByOrFail({ id: retained.id })).metadata.media).toEqual(media);
    });

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

    it.each([['https://example.com/cat.png'], ['HTTPS://example.com/cat.png'], ['http://example.com/cat.png']])(
      'skips the URL pointer %s rather than decoding it as base64',
      async url => {
        // A URL-based send stores the URL STRING as `data`. Buffer.from(url, 'base64') does not
        // throw — it yields ~18 bytes of noise — and the archive is consulted BEFORE the inline
        // fallback, so an archived garbage file would be served in place of the correct 404.
        const row = await saveRow({ mimetype: 'image/png', data: url });

        expect(await enabled().archive(row)).toBeNull();

        expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
        const files = [];
        for await (const f of storageService.iterateFiles('')) files.push(f);
        expect(files).toEqual([]);
      },
    );

    it('does not re-archive a row that already points at a file', async () => {
      // Outbound rows have two possible writers (the REST/bulk persist and the engine echo), so the
      // same row can reach archive() twice; a second write would orphan the first file.
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const first = await enabled().archive(row);

      const reloaded = await repository.findOneByOrFail({ id: row.id });
      expect(await enabled().archive(reloaded)).toBeNull();

      const files = [];
      for await (const f of storageService.iterateFiles('')) files.push(f);
      expect(files).toEqual([first]);
    });

    it('keeps one file when two writers archive the same row concurrently', async () => {
      // Both callers hold a snapshot read before either pointer landed, so the in-memory guard
      // passes twice; the pointer write itself has to pick one winner.
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });

      const keys = await Promise.all([enabled().archive(row), enabled().archive(row)]);
      const winner = keys.filter(k => k !== null);

      expect(winner).toHaveLength(1);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBe(winner[0]);
      const files = [];
      for await (const f of storageService.iterateFiles('')) files.push(f);
      expect(files).toEqual(winner);
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

    it('still returns null when the unreferenced file cannot be removed after a skipped update', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const update = jest
        .spyOn(repository, 'update')
        .mockResolvedValueOnce({ affected: 0, raw: [], generatedMaps: [] });
      const del = jest.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(new Error('s3 down'));

      await expect(enabled().archive(row)).resolves.toBeNull();

      expect(del).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${CHAT_MEDIA_PREFIX}sess-1/`)));
      update.mockRestore();
      del.mockRestore();
    });

    it('does not point a row revoked while its file was written back at the media', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      // The archive works from the in-memory row the projector inserted; the revoke lands meanwhile.
      await repository.update({ id: row.id }, { type: 'revoked', body: '' });

      await expect(enabled().archive(row)).resolves.toBeNull();

      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
      const files = [];
      for await (const f of storageService.iterateFiles(CHAT_MEDIA_PREFIX)) files.push(f);
      expect(files).toEqual([]);
    });
  });

  describe('archive with MESSAGE_INLINE_MEDIA=archive', () => {
    const replacing = (overrides: Record<string, unknown> = {}): ChatMediaArchiveService =>
      enabled({ 'chatMedia.inlineMode': 'archive', ...overrides });
    const mediaOf = async (id: string) =>
      ((await repository.findOneByOrFail({ id })).metadata as { media: Record<string, unknown> }).media;

    it('replaces the inline copy with the archived marker once the file is stored', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64'), filename: 'cat.png' });

      const key = await replacing().archive(row);

      expect(key).not.toBeNull();
      expect(await mediaOf(row.id)).toEqual({
        mimetype: 'image/png',
        filename: 'cat.png',
        omitted: true,
        sizeBytes: PNG.length,
        archived: true,
      });
      // The bytes now live once, in the store, and the media route reads them from there.
      expect(await storageService.getFile(key!)).toEqual(PNG);
    });

    it('keeps the rest of the metadata the row gained since it was persisted', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await repository.update(
        { id: row.id },
        {
          metadata: { ...row.metadata, quotedMessage: { id: 'q1', body: 'hi' } },
        },
      );

      await replacing().archive(row);

      const reloaded = await repository.findOneByOrFail({ id: row.id });
      expect((reloaded.metadata as { quotedMessage: unknown }).quotedMessage).toEqual({ id: 'q1', body: 'hi' });
      expect((reloaded.metadata as { media: { data?: string } }).media.data).toBeUndefined();
    });

    it('keeps the inline copy when the stored file does not read back intact', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });
      const get = jest.spyOn(storageService, 'getFile').mockResolvedValueOnce(Buffer.from('truncated'));

      expect(await replacing().archive(row)).toBeNull();

      expect((await mediaOf(row.id)).data).toBe(base64);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
      get.mockRestore();
    });

    it('keeps the inline copy when the read-back fails', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });
      const get = jest.spyOn(storageService, 'getFile').mockRejectedValueOnce(new Error('s3 down'));

      await expect(replacing().archive(row)).resolves.toBeNull();

      expect((await mediaOf(row.id)).data).toBe(base64);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
      get.mockRestore();
    });

    it('keeps metadata changed between the inline snapshot and replacement', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });
      const originalFindOne = repository.findOne.bind(repository);
      const find = jest.spyOn(repository, 'findOne').mockImplementationOnce(async options => {
        const snapshot = await originalFindOne(options);
        await repository.update({ id: row.id }, { metadata: { ...row.metadata, reactions: { user: 'ok' } } });
        return snapshot;
      });

      await replacing().archive(row);

      find.mockRestore();
      const current = await repository.findOneByOrFail({ id: row.id });
      expect(current.metadata).toEqual({ ...row.metadata, reactions: { user: 'ok' } });
      expect(current.mediaPath).toBeNull();
    });

    it('keeps an inline payload that changed while the archive was written', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const changedMedia = { mimetype: 'image/png', data: Buffer.from('new bytes').toString('base64') };
      const originalPut = storageService.putFile.bind(storageService);
      const put = jest.spyOn(storageService, 'putFile').mockImplementationOnce(async (key, bytes) => {
        await originalPut(key, bytes);
        await repository.update({ id: row.id }, { metadata: { media: changedMedia } });
      });

      await replacing().archive(row);

      put.mockRestore();
      expect(await mediaOf(row.id)).toEqual(changedMedia);
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
    });

    it('does not publish media revoked while the verified snapshot was read', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const originalFindOne = repository.findOne.bind(repository);
      const find = jest.spyOn(repository, 'findOne').mockImplementationOnce(async options => {
        const snapshot = await originalFindOne(options);
        await repository.update({ id: row.id }, { type: 'revoked', metadata: null as unknown as undefined });
        return snapshot;
      });

      expect(await replacing().archive(row)).toBeNull();

      find.mockRestore();
      const current = await repository.findOneByOrFail({ id: row.id });
      expect(current.type).toBe('revoked');
      expect(current.metadata).toBeNull();
      expect(current.mediaPath).toBeNull();
    });

    it('keeps the inline copy when the file could not be written', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });
      const put = jest.spyOn(storageService, 'putFile').mockRejectedValueOnce(new Error('disk on fire'));

      await replacing().archive(row);

      expect((await mediaOf(row.id)).data).toBe(base64);
      put.mockRestore();
    });

    it('keeps the inline copy of media above the archive cap, which is not archived', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });

      expect(await replacing({ 'chatMedia.maxBytes': 4 }).archive(row)).toBeNull();

      expect((await mediaOf(row.id)).data).toBe(base64);
    });

    it('leaves the inline copy alone in the default inline mode', async () => {
      const base64 = PNG.toString('base64');
      const row = await saveRow({ mimetype: 'image/png', data: base64 });

      await enabled({ 'chatMedia.inlineMode': 'inline' }).archive(row);

      expect((await mediaOf(row.id)).data).toBe(base64);
    });
  });

  describe('getMedia', () => {
    it('resolves an archived file by session + chat + WhatsApp message id', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const key = await enabled().archive(row);

      expect(await enabled().getMedia('sess-1', [row.chatId], row.waMessageId)).toEqual({
        path: key,
        mimetype: 'image/png',
      });
    });

    it('returns null for a revoked message that still points at a file', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await enabled().archive(row);
      await repository.update({ id: row.id }, { type: 'revoked' });

      expect(await enabled().getMedia('sess-1', [row.chatId], row.waMessageId)).toBeNull();
    });

    it('returns null for a message with nothing archived', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      expect(await enabled().getMedia('sess-1', [row.chatId], row.waMessageId)).toBeNull();
    });

    it('does not leak another session’s archived media', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      await enabled().archive(row);

      expect(await enabled().getMedia('other-sess', [row.chatId], row.waMessageId)).toBeNull();
    });

    it('matches any of the caller’s chatId dialects', async () => {
      // An outbound row stores the caller's literal chatId or the engine-neutral form depending on
      // which writer won the persist race, so the archive lookup must accept both — the same
      // duality MessageService already resolves for the inline fallback.
      const row = await saveRow(
        { mimetype: 'image/png', data: PNG.toString('base64') },
        { chatId: '628111@s.whatsapp.net', direction: MessageDirection.OUTGOING },
      );
      const key = await enabled().archive(row);

      expect(await enabled().getMedia('sess-1', ['628111@c.us', '628111@s.whatsapp.net'], row.waMessageId)).toEqual({
        path: key,
        mimetype: 'image/png',
      });
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

    // Explicit timeout: this is the one case in the file that seeds four figures of rows and drives
    // them through real SQLite and a real temp filesystem, so it is genuinely slow rather than
    // waiting on anything. Jest's 5s default left no headroom for that work once the rest of the
    // suite was running beside it, and it timed out on every full-suite run while passing whenever
    // the file was run alone — a failure that reported itself as a product bug and was not one.
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
    }, 30_000);

    it('does not let a batch of undeletable files block newer expired rows', async () => {
      // Ids sort the undeletable rows first: a purge that restarted from the lowest id after an
      // all-failed batch would never reach the rows behind them.
      const id = (prefix: string, i: number): string => `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const rows = [
        ...Array.from({ length: 510 }, (_, i) => ({
          id: id('00000000', i),
          mediaPath: `${CHAT_MEDIA_PREFIX}bad/${i}.png`,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          id: id('ffffffff', i),
          mediaPath: `${CHAT_MEDIA_PREFIX}good/${i}.png`,
        })),
      ];
      for (let i = 0; i < rows.length; i += 100) {
        await repository.insert(
          rows.slice(i, i + 100).map(r => ({
            ...r,
            sessionId: 'sess-1',
            chatId: '628111@c.us',
            waMessageId: r.id,
            from: '628111@c.us',
            to: 'me@c.us',
            body: '',
            type: 'image',
            direction: MessageDirection.INCOMING,
            status: MessageStatus.SENT,
            mediaMimetype: 'image/png',
          })),
        );
      }
      await repository.query('UPDATE messages SET createdAt = ?', [
        new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      ]);
      const del = jest
        .spyOn(storageService, 'deleteFile')
        .mockImplementation(key => (key.includes('/bad/') ? Promise.reject(new Error('EACCES')) : Promise.resolve()));

      const svc = enabled({ 'chatMedia.ttlDays': 7 });

      // A batch where every delete fails ends the run instead of walking on through the backlog.
      expect(await svc.purgeExpired(Date.now())).toBe(0);
      expect(del.mock.calls.length).toBe(500);
      // The next run resumes after that batch.
      expect(await svc.purgeExpired(Date.now())).toBe(5);
      expect(del.mock.calls.length).toBe(515);
      expect(await repository.count({ where: { mediaPath: Not(IsNull()) } })).toBe(510);
      // Once the walk is drained, the next run starts over and retries the undeletable rows.
      await svc.purgeExpired(Date.now());
      expect(del.mock.calls[515][0]).toBe(`${CHAT_MEDIA_PREFIX}bad/0.png`);
      del.mockRestore();
    }, 30_000);

    it('does not plan the batch select as a walk of the whole table on SQLite', async () => {
      // Ordering by the bare primary key lets SQLite satisfy ORDER BY from its autoindex and then
      // visit every row in the table, which blocks the event loop on every tick once the backlog is
      // drained. The plan must start from the createdAt range instead.
      await seedExpired(1);
      const runner = Object.getPrototypeOf(ds.createQueryRunner()) as {
        query: (sql: string, params?: unknown[]) => Promise<unknown>;
      };
      const query = jest.spyOn(runner, 'query');

      await enabled({ 'chatMedia.ttlDays': 7 }).purgeExpired(Date.now());

      const select = query.mock.calls.find(([sql]) => /^SELECT/i.test(sql) && /LIMIT/i.test(sql));
      query.mockRestore();
      expect(select).toBeDefined();
      const plan = await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${select![0]}`, select![1]);
      expect(plan.map(p => p.detail).join('\n')).not.toMatch(/SCAN .*sqlite_autoindex_messages/);
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

    it('warns and keeps the file when deleting an orphan past its grace window fails', async () => {
      const key = `${CHAT_MEDIA_PREFIX}sess-1/orphan.png`;
      await storageService.putFile(key, PNG);
      const svc = enabled({ 'chatMedia.orphanGraceMs': 0 });
      const warn = jest.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, 'warn');
      const del = jest.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(new Error('s3 down'));

      expect(await svc.sweepOrphanedMedia(Date.now())).toBe(0);

      expect(warn).toHaveBeenCalledWith(`Failed to delete orphaned chat media ${key}`, { error: 'Error: s3 down' });
      expect(await storageService.getFile(key)).toEqual(PNG);
      del.mockRestore();
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
    const backdate = (id: string, daysAgo: number): Promise<unknown> =>
      repository.query('UPDATE messages SET createdAt = ? WHERE id = ?', [
        new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        id,
      ]);

    it('schedules both sweeps even while archiving is off', () => {
      const setInterval = jest.spyOn(global, 'setInterval');
      const svc = build();

      svc.onModuleInit();

      // The flag gates the WRITER, not the store. Turning it off on a deployment that has been
      // archiving leaves every file and every pointer in place, so the maintenance the sweeps
      // perform — TTL expiry and orphan reclamation — is exactly what still has work to do.
      expect(setInterval).toHaveBeenCalledTimes(2);
      svc.onModuleDestroy();
      setInterval.mockRestore();
    });

    it('logs a failed purge or orphan sweep instead of leaving the rejection unhandled', async () => {
      const svc = build();
      jest.spyOn(svc, 'purgeExpired').mockRejectedValue(new Error('db gone'));
      jest.spyOn(svc, 'sweepOrphanedMedia').mockRejectedValue(new Error('bucket gone'));
      const logError = jest
        .spyOn((svc as unknown as { logger: { error: (...args: unknown[]) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
      try {
        svc.onModuleInit();
        await new Promise(resolve => setImmediate(resolve));

        expect(logError).toHaveBeenCalledWith('Chat media purge failed', expect.stringContaining('db gone'));
        expect(logError).toHaveBeenCalledWith('Chat media orphan sweep failed', expect.stringContaining('bucket gone'));
      } finally {
        svc.onModuleDestroy();
      }
    });

    it('still expires an archived file past its TTL while archiving is off', async () => {
      const row = await saveRow({ mimetype: 'image/png', data: PNG.toString('base64') });
      const key = await enabled().archive(row);
      await backdate(row.id, 10);

      expect(await build({ 'chatMedia.ttlDays': 7 }).purgeExpired(Date.now())).toBe(1);

      await expect(storageService.getFile(key!)).rejects.toThrow();
      expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBeNull();
    });

    it('still reaps an unreferenced archive file while archiving is off', async () => {
      await storageService.putFile(`${CHAT_MEDIA_PREFIX}sess-1/orphan.png`, PNG);
      const svc = build({ 'chatMedia.orphanGraceMs': 0 });

      expect(await svc.sweepOrphanedMedia(Date.now())).toBe(1);

      await expect(storageService.getFile(`${CHAT_MEDIA_PREFIX}sess-1/orphan.png`)).rejects.toThrow();
    });

    it('skips a purge tick while the previous purge is still running', async () => {
      const row = await saveRow(undefined, {
        mediaPath: `${CHAT_MEDIA_PREFIX}sess-1/f.png`,
        mediaMimetype: 'image/png',
      });
      await backdate(row.id, 10);
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      let releaseDelete: () => void = () => undefined;
      const del = jest
        .spyOn(storageService, 'deleteFile')
        .mockImplementationOnce(() => new Promise<void>(resolve => (releaseDelete = resolve)));
      const svc = build({ 'chatMedia.ttlDays': 7 });
      const sweep = jest.spyOn(svc, 'sweepOrphanedMedia').mockResolvedValue(0);
      const select = jest.spyOn(repository, 'createQueryBuilder');
      try {
        svc.onModuleInit();
        await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
        await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(select).toHaveBeenCalledTimes(1);

        releaseDelete();
        await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(select.mock.calls.length).toBeGreaterThan(1);
      } finally {
        svc.onModuleDestroy();
        releaseDelete();
        [del, sweep, select].forEach(spy => spy.mockRestore());
        jest.useRealTimers();
      }
    });

    it('skips an orphan sweep tick while the previous sweep is still running', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const svc = build({ 'chatMedia.orphanSweepIntervalMs': 60_000 });
      let release: () => void = () => undefined;
      const sweep = jest
        .spyOn(svc, 'sweepOrphanedMedia')
        .mockImplementationOnce(() => new Promise<number>(resolve => (release = () => resolve(0))))
        .mockResolvedValue(0);
      const purge = jest.spyOn(svc, 'purgeExpired').mockResolvedValue(0);
      try {
        svc.onModuleInit();
        await jest.advanceTimersByTimeAsync(60_000);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(sweep).toHaveBeenCalledTimes(1);

        release();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(sweep).toHaveBeenCalledTimes(2);
      } finally {
        svc.onModuleDestroy();
        release();
        [sweep, purge].forEach(spy => spy.mockRestore());
        jest.useRealTimers();
      }
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
