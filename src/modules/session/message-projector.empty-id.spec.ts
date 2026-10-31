import { DataSource, type Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { HookManager } from '../../core/hooks';
import type { EventsGateway } from '../events/events.gateway';
import { Message } from '../message/entities/message.entity';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { WebhookService } from '../webhook/webhook.service';
import { MessageProjector } from './message-projector.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type { Session } from './entities/session.entity';
import { deferred } from './inbound-room';

const flush = async (): Promise<void> => {
  for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve));
};

// An engine that cannot read a message's id reports the empty sentinel for it. Such an id names no message, so
// a change that carries it must not reach a message that is still being written under the same sentinel.
describe('a change that names no message id', () => {
  let db: DataSource;
  let repository: Repository<Message>;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let announced: string[];
  let release: () => void;

  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    repository = db.getRepository(Message);
    const engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set('s1', engine);
    announced = [];
    const gate = deferred<void>();
    release = () => gate.resolve();
    projector = new MessageProjector(
      repository,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      { emitMessage: jest.fn(), emitMessageRevoked: jest.fn() } as unknown as EventsGateway,
      {
        dispatch: jest.fn((_session: string, event: string) => {
          announced.push(event);
          return Promise.resolve();
        }),
      } as unknown as WebhookService,
      {
        execute: jest.fn(async (event: string, data: unknown) => {
          if (event === 'message:received' || event === 'message:sent') await gate.promise;
          return { continue: true, data };
        }),
      } as unknown as HookManager,
      {} as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it.each([
    ['received', false],
    ['sent', true],
  ])('does not take back an unrelated message %s that is still in its hook chain', async (event, fromMe) => {
    const chatId = '628111@c.us';
    const message: IncomingMessage = {
      id: '',
      chatId,
      from: fromMe ? '620000@c.us' : chatId,
      to: fromMe ? chatId : '620000@c.us',
      fromMe,
      body: 'hello',
      type: 'text',
      timestamp: 1_700_000_000,
      isGroup: false,
      kind: 'individual',
    };
    if (fromMe) projector.handleOwnSendEcho('s1', engine, message);
    else projector.handleInboundMessage('s1', engine, message);
    await flush();
    projector.handleMessageRevoked('s1', engine, { id: '', chatId } as never);
    await flush();
    release();
    await flush();

    expect(await repository.find()).toEqual([expect.objectContaining({ body: 'hello', type: 'text' })]);
    expect(announced).toContain(`message.${event}`);
  });
});
