import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, type Repository } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { HookManager } from '../../core/hooks';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import { Message } from '../message/entities/message.entity';
import type { Session } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import { SessionEngineLeafEvents } from '../session/session-engine-leaf-events';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';
import { StorageService } from '../../common/storage/storage.service';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';

/**
 * whatsapp-web.js raises `message` for a message WhatsApp Web adds already deleted, and a fetch of the status
 * chat's recent messages returns such a story too: its type is `revoked`, its body empty. It is a story its poster
 * took back, so it must neither be stored nor announced, on the live path or in the backfill made on connect.
 */

const story = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `false_status@broadcast_${id}_628111222333@c.us`,
  chatId: 'status@broadcast',
  from: 'status@broadcast',
  to: '620000000000@c.us',
  author: '628111222333@c.us',
  fromMe: false,
  body: '',
  type: 'text',
  timestamp: Math.floor(Date.now() / 1000),
  isGroup: false,
  kind: 'status',
  isStatusBroadcast: true,
  ...overrides,
});
const deletedStory = (): IncomingMessage => story('3EB0DELETED', { type: 'revoked' });
const liveStory = (): IncomingMessage => story('3EB0LIVE', { body: 'hello story' });

describe('a status that arrives already deleted by its poster', () => {
  let dir: string;
  let db: DataSource;
  let store: StatusStoreService;
  let config: ConfigService;
  let dispatched: string[];
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-deleted-'));
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, StatusUpdate],
      synchronize: true,
    }).initialize();
    const values: Record<string, unknown> = { 'storage.type': 'local', 'storage.localPath': dir };
    config = { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as unknown as ConfigService;
    store = new StatusStoreService(db.getRepository(StatusUpdate), new StorageService(config), config);
    engines = new EngineRegistry();
    engine = {
      getChatHistory: jest.fn().mockResolvedValue([deletedStory(), liveStory()]),
      getContactById: jest.fn().mockResolvedValue(null),
    } as unknown as IWhatsAppEngine;
    engines.set('s1', engine);
    dispatched = [];
    projector = new MessageProjector(
      db.getRepository(Message),
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      { emitMessage: jest.fn(), emitStatusReceived: jest.fn() } as unknown as EventsGateway,
      {
        dispatch: jest.fn((_session: string, event: string) => {
          dispatched.push(event);
          return Promise.resolve();
        }),
      } as unknown as WebhookService,
      {
        execute: jest.fn((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
      } as unknown as HookManager,
      store,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  afterEach(async () => {
    await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('on the live receive path', () => {
    it('stores and announces a story that is still up', async () => {
      await projector.handleInboundMessage('s1', engine, liveStory())?.settled;

      expect((await store.list('s1')).map(s => s.id)).toEqual([liveStory().id]);
      expect(dispatched).toEqual(['status.received']);
    });

    it('stores nothing and announces nothing for a deleted one', async () => {
      await projector.handleInboundMessage('s1', engine, deletedStory())?.settled;

      expect(await store.list('s1')).toEqual([]);
      expect(dispatched).toEqual([]);
    });
  });

  describe('in the backfill made on connect', () => {
    it('skips a deleted story and still stores the one next to it', async () => {
      const leaf = new SessionEngineLeafEvents({
        statusStore: store,
        configService: config,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      } as unknown as ConstructorParameters<typeof SessionEngineLeafEvents>[0]);

      await leaf.seedStatuses('s1', engine);

      expect((await store.list('s1')).map(s => s.id)).toEqual([liveStory().id]);
    });
  });
});
