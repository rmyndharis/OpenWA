import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, type Repository } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type {
  IncomingMessage,
  IWhatsAppEngine,
  RevokedMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { HookManager } from '../../core/hooks';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import type { Session } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';
import { StorageService } from '../../common/storage/storage.service';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';

const SESSION = 's1';
const SELF = '620000000000@c.us';
const POSTER = '628111222333@c.us';
const POSTER_LID = '111111111111111@lid';
const OTHER = '628444555666@c.us';
const STORY = '3EB0A1B2C3D4E5F6';

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n++) await new Promise(resolve => setTimeout(resolve, 5));
};

/** A step a case holds until it opens the gate, and a way to wait until the step has reached it. */
const gate = (): { reach: () => void; reached: Promise<void>; open: () => void; opened: Promise<void> } => {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>(resolve => (reach = resolve));
  const opened = new Promise<void>(resolve => (open = resolve));
  return { reach, reached, open, opened };
};

/** What Baileys says of a revoke it announces: whether the account made it, and who sent it. */
const sentBy = (participant?: string, fromMe = false): { fromMe: boolean; participant?: string } => ({
  fromMe,
  participant,
});

// WhatsApp takes a story off its viewers' feeds the moment its poster deletes it: the deletion reaches them as a
// revoke of the status message. The store already hides a story once its 24 hours are up, as WhatsApp does; a story
// its poster deleted has to leave the reads too, its media has to stop being served, and its file has to go.
describe('a received status its poster deleted', () => {
  let dir: string;
  let db: DataSource;
  let storage: StorageService;
  let store: StatusStoreService;
  let projector: MessageProjector;
  let engine: IWhatsAppEngine;
  let dispatch: jest.Mock;
  let lids: { findPhoneForLid: jest.Mock; findLidsForPhone: jest.Mock; resolveLid: jest.Mock };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-revoke-'));
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, StatusUpdate],
      synchronize: true,
    }).initialize();
    const values: Record<string, unknown> = { 'storage.type': 'local', 'storage.localPath': dir };
    const config = { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as unknown as ConfigService;
    storage = new StorageService(config);
    lids = {
      findPhoneForLid: jest.fn().mockResolvedValue(null),
      findLidsForPhone: jest.fn().mockResolvedValue([]),
      resolveLid: jest.fn().mockReturnValue(undefined),
    };
    store = new StatusStoreService(
      db.getRepository(StatusUpdate),
      storage,
      config,
      lids as unknown as LidMappingStoreService,
    );
    const engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set(SESSION, engine);
    dispatch = jest.fn().mockResolvedValue(undefined);
    projector = new MessageProjector(
      db.getRepository(Message),
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      {
        emitMessage: jest.fn(),
        emitMessageRevoked: jest.fn(),
        emitStatusReceived: jest.fn(),
      } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      {
        execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
      } as unknown as HookManager,
      store,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
    storage.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const story = (id: string, poster: string, withMedia = true): IncomingMessage => {
    const type: IncomingMessage['type'] = withMedia ? 'image' : 'text';
    return {
      id,
      chatId: 'status@broadcast',
      from: 'status@broadcast',
      to: SELF,
      author: poster,
      fromMe: false,
      body: 'posted by mistake',
      type,
      timestamp: Math.floor(Date.now() / 1000),
      isGroup: false,
      kind: 'status',
      isStatusBroadcast: true,
      ...(withMedia ? { media: { mimetype: 'image/jpeg', data: Buffer.from('jpeg bytes').toString('base64') } } : {}),
    };
  };

  /** Hand a story to the projector the way an engine does, and wait until it is stored and served. */
  const receive = async (id: string, poster: string, withMedia = true): Promise<void> => {
    await projector.handleInboundMessage(SESSION, engine, story(id, poster, withMedia))?.settled;
  };

  // As the adapters emit it: the chat is the status chat and the poster is nowhere in the payload.
  const revoke = (id: string, revokedId: string): RevokedMessage => ({
    id,
    revokedId,
    chatId: 'status@broadcast',
    from: 'status@broadcast',
    to: SELF,
    type: 'revoked',
    body: '',
    timestamp: Math.floor(Date.now() / 1000),
  });

  const rowCount = (): Promise<number> => db.getRepository(StatusUpdate).count();
  const storedFiles = async (): Promise<string[]> => {
    const keys: string[] = [];
    for await (const key of storage.iterateFiles('statuses/')) keys.push(key);
    return keys;
  };
  const announced = (event: string): unknown[] =>
    (dispatch.mock.calls as Array<[string, string, unknown]>).filter(call => call[1] === event).map(call => call[2]);

  const shapes: Array<[string, string, RevokedMessage, ReturnType<typeof sentBy> | undefined]> = [
    // Baileys: the revoke's key is the story's own, and the adapter says who sent it.
    ['Baileys', STORY, revoke(STORY, STORY), sentBy(POSTER)],
    // whatsapp-web.js: the notification has its own id, the story's is in revokedId, and no actor is passed.
    [
      'whatsapp-web.js',
      `false_status@broadcast_${STORY}_${POSTER}`,
      revoke(
        'false_status@broadcast_3EB0FFFF0000NOTICE_628111222333@c.us',
        `false_status@broadcast_${STORY}_${POSTER}`,
      ),
      undefined,
    ],
  ];

  describe.each(shapes)('on %s', (_engine, statusId, revoked, actor) => {
    it('is no longer listed or served once the revoke arrives, and its file is gone', async () => {
      await receive(statusId, POSTER);
      // Stored and served, as any received story is.
      expect((await store.list(SESSION)).map(status => status.id)).toEqual([statusId]);
      expect(await store.getMedia(SESSION, statusId)).not.toBeNull();
      expect(await storedFiles()).toHaveLength(1);

      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await settle();

      expect((await store.list(SESSION)).map(status => status.id)).toEqual([]);
      expect(await store.listByContact(SESSION, POSTER)).toEqual([]);
      expect(await store.getMedia(SESSION, statusId)).toBeNull();
      expect(await rowCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });

    it('leaves the other stories of the poster and of other contacts alone', async () => {
      await receive(statusId, POSTER);
      await receive('3EB0OTHERSTORY', POSTER);
      await receive('3EB0STRANGERS', OTHER);

      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await settle();

      expect((await store.list(SESSION)).map(status => status.id).sort()).toEqual(['3EB0OTHERSTORY', '3EB0STRANGERS']);
      expect(await storedFiles()).toHaveLength(2);
    });

    it('is a no-op for a story that was never stored', async () => {
      await receive('3EB0OTHERSTORY', POSTER);

      expect(() => projector.handleMessageRevoked(SESSION, engine, revoked, actor)).not.toThrow();
      await settle();

      expect((await store.list(SESSION)).map(status => status.id)).toEqual(['3EB0OTHERSTORY']);
    });

    it('still announces message.revoked as before', async () => {
      await receive(statusId, POSTER);

      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await settle();

      expect(announced('message.revoked')).toEqual([expect.objectContaining({ chatId: 'status@broadcast' })]);
    });

    it('removes the story when the revoke is handed over in the same turn as the story', async () => {
      const receipt = projector.handleInboundMessage(SESSION, engine, story(statusId, POSTER));
      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await receipt?.settled;
      await settle();

      expect(await rowCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });

    it('leaves no file and announces no status.received for a story deleted while its media is written', async () => {
      let entered!: () => void;
      const writing = new Promise<void>(resolve => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      const put = storage.putFile.bind(storage);
      jest.spyOn(storage, 'putFile').mockImplementation(async (key: string, data: Buffer) => {
        entered();
        await gate;
        return put(key, data);
      });

      const receipt = projector.handleInboundMessage(SESSION, engine, story(statusId, POSTER));
      await writing; // the row is saved, the file is being written
      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await settle();
      expect(await rowCount()).toBe(0);

      release();
      await receipt?.settled;
      await settle();

      expect(await storedFiles()).toEqual([]);
      expect(announced('status.received')).toEqual([]);
    });

    it('removes the story when a second ingest of it joins before the first row is saved', async () => {
      const repository = db.getRepository(StatusUpdate);
      const save = repository.save.bind(repository) as (...args: unknown[]) => Promise<unknown>;
      const saves = [gate(), gate()];
      let started = 0;
      jest.spyOn(repository, 'save').mockImplementation(((...args: unknown[]) => {
        const mine = saves[started++];
        mine.reach();
        return mine.opened.then(() => save(...args));
      }) as never);

      const first = projector.handleInboundMessage(SESSION, engine, story(statusId, POSTER, false));
      await saves[0].reached;
      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      // The connect-time seed ingests the story again while the delete still waits for the first save.
      const second = projector.handleInboundMessage(SESSION, engine, story(statusId, POSTER, false));
      await saves[1].reached;
      saves[0].open();
      await first?.settled;
      await settle();
      saves[1].open();
      await second?.settled;
      await settle();

      expect(await rowCount()).toBe(0);
    });

    it('removes the story when a second ingest of it starts while the delete is still reading', async () => {
      await receive(statusId, POSTER, false);
      const repository = db.getRepository(StatusUpdate);
      const findOne = repository.findOne.bind(repository);
      const deleteRead = gate();
      const ingestRead = gate();
      jest.spyOn(repository, 'findOne').mockImplementation(async options => {
        if (options.select) {
          // The delete's own read: it has the row, and waits before it deletes it.
          const row = await findOne(options);
          deleteRead.reach();
          await deleteRead.opened;
          return row;
        }
        // The second ingest's lookup: it runs after the delete, so it finds no row to stop it.
        ingestRead.reach();
        await ingestRead.opened;
        return findOne(options);
      });

      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await deleteRead.reached;
      const second = projector.handleInboundMessage(SESSION, engine, story(statusId, POSTER, false));
      await ingestRead.reached;
      deleteRead.open();
      await settle();
      ingestRead.open();
      await second?.settled;
      await settle();

      expect(await rowCount()).toBe(0);
    });

    it('announces no status.received when its media write fails after the story was deleted', async () => {
      const writing = gate();
      jest.spyOn(storage, 'putFile').mockImplementation(async () => {
        writing.reach();
        await writing.opened;
        throw new Error('storage unavailable');
      });

      const receipt = projector.handleInboundMessage(SESSION, engine, story(statusId, POSTER));
      await writing.reached; // the row is saved, the file is being written
      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await settle();
      expect(await rowCount()).toBe(0);

      writing.open();
      await receipt?.settled;
      await settle();

      expect(announced('status.received')).toEqual([]);
    });

    it('still announces message.revoked and keeps the rest of the revoke path when the file cannot be deleted', async () => {
      await receive(statusId, POSTER);
      jest.spyOn(storage, 'deleteFile').mockRejectedValue(new Error('disk gone'));

      projector.handleMessageRevoked(SESSION, engine, revoked, actor);
      await settle();

      expect(await store.list(SESSION)).toEqual([]);
      expect(announced('message.revoked')).toHaveLength(1);
    });

    it('still announces message.revoked when the store cannot remove the story', async () => {
      await receive(statusId, POSTER);
      jest.spyOn(db.getRepository(StatusUpdate), 'delete').mockRejectedValue(new Error('database is locked'));

      expect(() => projector.handleMessageRevoked(SESSION, engine, revoked, actor)).not.toThrow();
      await settle();

      expect(announced('message.revoked')).toHaveLength(1);
    });
  });

  describe('on Baileys, where the adapter vouches for nothing once the stored copy is gone', () => {
    const revoked = revoke(STORY, STORY);

    it('keeps a story whose delete was sent by another contact', async () => {
      await receive(STORY, POSTER);

      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy(OTHER));
      await settle();

      expect((await store.list(SESSION)).map(status => status.id)).toEqual([STORY]);
      expect(await store.getMedia(SESSION, STORY)).not.toBeNull();
      expect(await storedFiles()).toHaveLength(1);
    });

    it('keeps a story whose delete names no sender', async () => {
      await receive(STORY, POSTER);

      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy());
      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy(''));
      await settle();

      expect((await store.list(SESSION)).map(status => status.id)).toEqual([STORY]);
    });

    it('keeps a story the account itself deleted from its phone', async () => {
      await receive(STORY, POSTER);

      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy(SELF, true));
      await settle();

      expect((await store.list(SESSION)).map(status => status.id)).toEqual([STORY]);
    });

    it('matches a poster stored under a lid with the phone number the delete names', async () => {
      lids.findPhoneForLid.mockImplementation((lid: string) =>
        Promise.resolve(lid === '111111111111111' ? '628111222333' : null),
      );
      lids.findLidsForPhone.mockImplementation((phone: string) =>
        Promise.resolve(phone === '628111222333' ? ['111111111111111'] : []),
      );
      await receive(STORY, POSTER_LID);

      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy(POSTER));
      await settle();

      expect(await rowCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });

    it('matches a poster stored under a phone number with the lid the delete names', async () => {
      lids.findPhoneForLid.mockImplementation((lid: string) =>
        Promise.resolve(lid === '111111111111111' ? '628111222333' : null),
      );
      lids.findLidsForPhone.mockImplementation((phone: string) =>
        Promise.resolve(phone === '628111222333' ? ['111111111111111'] : []),
      );
      await receive(STORY, POSTER);

      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy(POSTER_LID));
      await settle();

      expect(await rowCount()).toBe(0);
    });

    it('does not take a lid nothing resolves for the poster', async () => {
      await receive(STORY, POSTER);

      projector.handleMessageRevoked(SESSION, engine, revoked, sentBy('222222222222222@lid'));
      await settle();

      expect(await rowCount()).toBe(1);
    });
  });

  // Each pass of the delete is joined by another ingest of the story (a redelivery beside the connect-time seed and the
  // live message): the delete keeps looking until a pass starts none, however many that takes, because the last
  // ingest to join would otherwise save the story after the delete had answered.
  it('removes the story however many ingests of it join the delete one pass after another', async () => {
    const incoming = { waStatusId: STORY, contactJid: POSTER, type: 'text' as const, postedAt: Date.now() };
    await store.ingest(SESSION, incoming);
    const repository = db.getRepository(StatusUpdate);
    const remove = repository.delete.bind(repository);
    const joiners: Array<Promise<unknown>> = [];
    jest.spyOn(repository, 'delete').mockImplementation(async criteria => {
      const result = await remove(criteria);
      if (joiners.length < 20) joiners.push(store.ingest(SESSION, incoming));
      return result;
    });

    await expect(store.removeRevoked(SESSION, STORY)).resolves.toBe(true);
    await Promise.all(joiners);
    await settle();

    expect(await rowCount()).toBe(0);
    expect(joiners).toHaveLength(20);
  });

  it('ignores a revoke that names no story id', async () => {
    await receive(STORY, POSTER);

    projector.handleMessageRevoked(SESSION, engine, revoke('', ''));
    projector.handleMessageRevoked(SESSION, engine, revoke('', ''), sentBy(POSTER));
    await settle();

    expect(await rowCount()).toBe(1);
  });

  it('is not touched by the delete of a message that shares its id in a chat', async () => {
    await receive(STORY, POSTER);
    await db.getRepository(Message).save({
      sessionId: SESSION,
      waMessageId: STORY,
      chatId: '628999000111@c.us',
      from: '628999000111@c.us',
      to: SELF,
      body: 'hello',
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: 1_700_000_000,
    });
    const message: RevokedMessage = { ...revoke(STORY, STORY), chatId: '628999000111@c.us' };

    projector.handleMessageRevoked(SESSION, engine, message);
    await settle();

    // The message row is cleared as before, and the story with the same id stays.
    expect(await db.getRepository(Message).findOneByOrFail({ sessionId: SESSION, waMessageId: STORY })).toEqual(
      expect.objectContaining({ body: '', type: 'revoked' }),
    );
    expect((await store.list(SESSION)).map(status => status.id)).toEqual([STORY]);
    expect(await storedFiles()).toHaveLength(1);
  });
});
