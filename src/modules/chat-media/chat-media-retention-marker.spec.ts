import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/storage/storage.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { updateMessageMetadata } from '../message/message-metadata';
import { ChatMediaArchiveService } from './chat-media-archive.service';

const config = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback) }) as unknown as ConfigService;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention removes an archived file. Under MESSAGE_INLINE_MEDIA=archive the row then has no copy of the media
 * left, and it must stop saying it has one. SQLite in a file, since a test closes and reopens it; on PostgreSQL
 * (DATABASE_TYPE=postgres) a schema of its own, since the marker is found with SQL that differs by dialect.
 */
describe('archive-only media after retention removes the file', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let schema = '';
  const onServer = async (sql: string): Promise<void> => {
    const admin = await new DataSource(server).initialize();
    await admin.query(sql).finally(() => admin.destroy());
  };
  let dir: string;
  let ds: DataSource;
  let repository: Repository<Message>;
  let storage: StorageService;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-retention-marker-'));
    if (pg) {
      schema = `retention_marker_${randomUUID().replace(/-/g, '')}`;
      await onServer(`CREATE SCHEMA "${schema}"`);
    }
    const entities = [Message];
    ds = await new DataSource(
      pg
        ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities, synchronize: true }
        : { type: 'better-sqlite3', database: path.join(dir, 'data.sqlite'), entities, synchronize: true },
    ).initialize();
    repository = ds.getRepository(Message);
    storage = new StorageService(config({ 'storage.type': 'local', 'storage.localPath': path.join(dir, 'media') }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (ds.isInitialized) await ds.destroy();
    if (pg) await onServer(`DROP SCHEMA "${schema}" CASCADE`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const service = (inlineMode: 'inline' | 'archive'): ChatMediaArchiveService =>
    new ChatMediaArchiveService(
      repository,
      storage,
      config({ 'chatMedia.archiveEnabled': true, 'chatMedia.inlineMode': inlineMode, 'chatMedia.ttlDays': 1 }),
    );

  /** An inbound image row, archived by `archive` the way the projector does after persisting it. */
  async function archivedRow(
    archive: ChatMediaArchiveService,
    extra: Record<string, unknown> = {},
    bytes: Buffer = PNG,
  ): Promise<Message> {
    const row = await repository.save(
      repository.create({
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        waMessageId: `WA-${randomUUID()}`,
        from: '628111@c.us',
        to: 'me@c.us',
        body: '',
        type: 'image',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: 1,
        metadata: { media: { mimetype: 'image/png', data: bytes.toString('base64') }, ...extra },
      }),
    );
    expect(await archive.archive(row)).not.toBeNull();
    return repository.findOneByOrFail({ id: row.id });
  }

  const twoDaysLater = (): number => Date.now() + 2 * DAY_MS;

  it('no longer advertises an archived copy once the archived file is gone', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    expect(row.metadata.media).toMatchObject({ omitted: true, archived: true });
    await updateMessageMetadata(repository, { id: row.id }, metadata => ({ ...metadata, reactions: { a: 'like' } }));

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(await archive.getMedia('sess-1', ['628111@c.us'], row.waMessageId)).toBeNull();
    // The list API hands this metadata to clients; `archived: true` tells them the bytes are behind the
    // media route (the dashboard fetches a preview for it), and they no longer are.
    expect(after.metadata).toEqual({
      media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
      reactions: { a: 'like' },
    });
  });

  it('leaves the metadata of an inline-mode row untouched', async () => {
    const archive = service('inline');
    const row = await archivedRow(archive);
    const update = jest.spyOn(repository, 'update');

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata).toEqual(row.metadata);
    expect(update.mock.calls.filter(([, patch]) => 'metadata' in (patch as object))).toEqual([]);
  });

  it('keeps the marker and the columns while the file cannot be deleted', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    jest.spyOn(storage, 'deleteFile').mockRejectedValue(new Error('store unreachable'));

    expect(await archive.purgeExpired(twoDaysLater())).toBe(0);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBe(row.mediaPath);
    expect(after.metadata.media).toMatchObject({ archived: true });
  });

  it('keeps a reaction written while the marker is dropped', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    const update = repository.update.bind(repository);
    let raced = false;
    jest.spyOn(repository, 'update').mockImplementation(async (where, patch) => {
      if (!raced && 'metadata' in (patch as object)) {
        raced = true;
        await updateMessageMetadata(repository, { id: row.id }, metadata => ({
          ...metadata,
          reactions: { b: 'love' },
        }));
      }
      return update(where, patch);
    });

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.metadata).toEqual({
      media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
      reactions: { b: 'love' },
    });
  });

  it('retries a row on the next run when its marker could not be dropped', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive);
    const update = repository.update.bind(repository);
    const metadataWrites = jest
      .spyOn(repository, 'update')
      .mockImplementation((where, patch) =>
        'metadata' in (patch as object)
          ? Promise.resolve({ affected: 0, raw: [], generatedMaps: [] })
          : update(where, patch),
      );

    expect(await archive.purgeExpired(twoDaysLater())).toBe(0);
    expect((await repository.findOneByOrFail({ id: row.id })).mediaPath).toBe(row.mediaPath);

    metadataWrites.mockRestore();
    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata.media).not.toHaveProperty('archived');
  });

  it.each([
    ['ASCII, 70 000 characters', 'a'.repeat(70_000)],
    // 75 000 UTF-8 bytes, inside WhatsApp's 65 536-character text limit.
    ['CJK, 25 000 characters', '中'.repeat(25_000)],
  ])('drops the marker of a media reply quoting a long text (%s)', async (_label, quotedBody) => {
    const archive = service('archive');
    const row = await archivedRow(archive, { quotedMessage: { id: 'QUOTED-1', body: quotedBody } });
    expect(row.metadata.media).toMatchObject({ omitted: true, archived: true });

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata).toEqual({
      media: { mimetype: 'image/png', omitted: true, sizeBytes: PNG.length },
      quotedMessage: { id: 'QUOTED-1', body: quotedBody },
    });
  });

  it('neither reads nor rewrites a large inline copy while looking for the marker', async () => {
    const archive = service('inline');
    const row = await archivedRow(archive, {}, randomBytes(100 * 1024));
    const read = jest.spyOn(repository, 'findOne');
    const update = jest.spyOn(repository, 'update');

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata).toEqual(row.metadata);
    expect(read).not.toHaveBeenCalled();
    expect(update.mock.calls.filter(([, patch]) => 'metadata' in (patch as object))).toEqual([]);
  });

  it('keeps a large row whose marker could not be looked for until the next run', async () => {
    const archive = service('archive');
    const row = await archivedRow(archive, { quotedMessage: { id: 'QUOTED-1', body: 'a'.repeat(70_000) } });
    jest.spyOn(SelectQueryBuilder.prototype, 'getExists').mockRejectedValueOnce(new Error('database busy'));

    expect(await archive.purgeExpired(twoDaysLater())).toBe(0);
    const kept = await repository.findOneByOrFail({ id: row.id });
    expect(kept.mediaPath).toBe(row.mediaPath);
    expect(kept.metadata.media).toMatchObject({ archived: true });

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);
    const after = await repository.findOneByOrFail({ id: row.id });
    expect(after.mediaPath).toBeNull();
    expect(after.metadata.media).not.toHaveProperty('archived');
  });

  it('lets the event loop run between the marker lookups of large inline copies', async () => {
    const archive = service('inline');
    for (let i = 0; i < 5; i++) await archivedRow(archive, {}, randomBytes(100 * 1024));
    // Each lookup scans a whole inline copy, and better-sqlite3 answers it without a turn of the event loop.
    let turns = 0;
    let spinning = true;
    const spin = (): void => {
      turns++;
      if (spinning) setImmediate(spin);
    };
    setImmediate(spin);
    const turnsAtLookup: number[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called through with its own receiver
    const getExists = SelectQueryBuilder.prototype.getExists;
    jest.spyOn(SelectQueryBuilder.prototype, 'getExists').mockImplementation(function (
      this: SelectQueryBuilder<never>,
    ) {
      turnsAtLookup.push(turns);
      return getExists.call(this);
    });

    const cleared = await archive.purgeExpired(twoDaysLater()).finally(() => (spinning = false));

    expect(cleared).toBe(5);
    expect(turnsAtLookup).toHaveLength(5);
    for (let i = 1; i < turnsAtLookup.length; i++) {
      expect(turnsAtLookup[i]).toBeGreaterThan(turnsAtLookup[i - 1]);
    }
  });

  // PostgreSQL computes OCTET_LENGTH and IS NOT NULL from the stored header either way; SQLite does not.
  (pg ? it.skip : it)('reads only the size of a large row in the bulk marker statement', async () => {
    const archive = service('inline');
    await archivedRow(archive);
    let issued: [string, unknown[]] | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called through with its own receiver
    const getRawMany = SelectQueryBuilder.prototype.getRawMany;
    jest.spyOn(SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(function (
      this: SelectQueryBuilder<never>,
    ) {
      if (this.getQuery().includes('CASE WHEN')) issued = this.getQueryAndParameters();
      return getRawMany.call(this);
    });

    expect(await archive.purgeExpired(twoDaysLater())).toBe(1);

    const columns = await ds.query<Array<{ cid: number; name: string }>>(
      `PRAGMA table_info("${repository.metadata.tableName}")`,
    );
    const metadata = columns.find(column => column.name === 'metadata')!.cid;
    const program = await ds.query<Array<{ opcode: string; p2: number; p5: number }>>(
      `EXPLAIN ${issued![0]}`,
      issued![1],
    );
    // A Column read flagged for a length (p5 bit 0x40) stops at the record header; any other loads the whole value.
    const wholeLoads = program.filter(op => op.opcode === 'Column' && op.p2 === metadata && (op.p5 & 0x40) === 0);
    // The one is the LIKE branch, which runs only for a row of 64 KiB or less.
    expect(wholeLoads).toHaveLength(1);
  });

  it.each([
    ['the data source closes', (): Promise<void> => ds.destroy()],
    ['the module is destroyed', (archive: ChatMediaArchiveService): void => archive.onModuleDestroy()],
  ])(
    'stops when %s during the marker lookups and leaves the rest for the next run',
    async (_label, shutDown: (archive: ChatMediaArchiveService) => unknown) => {
      const archive = service('inline');
      for (let i = 0; i < 20; i++) await archivedRow(archive, {}, randomBytes(100 * 1024));
      const logger = (archive as unknown as { logger: Record<'log' | 'warn' | 'error', (...args: unknown[]) => void> })
        .logger;
      const lines = (['log', 'warn', 'error'] as const).map(level => jest.spyOn(logger, level));
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called through with its own receiver
      const getExists = SelectQueryBuilder.prototype.getExists;
      let lookups = 0;
      jest.spyOn(SelectQueryBuilder.prototype, 'getExists').mockImplementation(async function (
        this: SelectQueryBuilder<never>,
      ) {
        const marked = await getExists.call(this);
        if (++lookups === 3) await shutDown(archive);
        return marked;
      });

      const failed = await archive.purgeExpired(twoDaysLater()).then(
        () => 0,
        () => 1,
      );

      // A failed run is one line where it is scheduled; nothing else may be logged per remaining row.
      expect(lines.reduce((sum, spy) => sum + spy.mock.calls.length, failed)).toBeLessThanOrEqual(1);
      expect(lookups).toBe(3);
      if (!ds.isInitialized) {
        ds = await new DataSource(ds.options).initialize();
        repository = ds.getRepository(Message);
      }
      const left = await repository.count({ where: { mediaPath: Not(IsNull()) } });
      expect(left).toBeGreaterThanOrEqual(17);
      expect(await service('inline').purgeExpired(twoDaysLater())).toBe(left);
      expect(await repository.count({ where: { mediaPath: Not(IsNull()) } })).toBe(0);
    },
  );
});
