import { DataSource } from 'typeorm';
import { HookManager } from '../../core/hooks';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session } from '../session/entities/session.entity';
import { BulkMessageService } from './bulk-message.service';
import { MessageBatch } from './entities/message-batch.entity';
import { Message } from './entities/message.entity';
import type { MessageService } from './message.service';
import type { SendPacingService } from './send-pacing.service';

describe('bulk mentions', () => {
  let db: DataSource;
  let bulk: BulkMessageService;
  let send: jest.Mock;
  let hooks: HookManager;
  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, MessageBatch, Session],
      synchronize: true,
    }).initialize();
    await db.getRepository(Session).save({ id: 's1', name: 'sender', config: {} });
    const engines = new EngineRegistry();
    send = jest.fn().mockResolvedValue({ id: 'sent-1', timestamp: 1700000000 });
    engines.set('s1', { sendImageMessage: send, sendTextMessage: send } as unknown as IWhatsAppEngine);
    hooks = new HookManager();
    bulk = new BulkMessageService(
      db.getRepository(MessageBatch),
      engines,
      { saveOutgoingMessage: () => Promise.resolve() } as unknown as MessageService,
      hooks,
      {
        assertSendAllowed: () => Promise.resolve(),
        recordSendFailure: () => undefined,
        recordSendSuccess: () => undefined,
      } as unknown as SendPacingService,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });

  it('refuses a rendered mention that does not identify a person', async () => {
    const processing = jest.spyOn(bulk as unknown as { processBatch: () => Promise<void> }, 'processBatch');
    const batch = await bulk.createBatch('s1', {
      messages: [
        {
          chatId: '120363000000000000@g.us',
          type: 'text',
          content: { text: 'Hi @{{phone}}', mentions: ['{{phone}}@c.us'] },
          variables: { phone: 'not-a-person' },
        },
      ],
    });
    await processing.mock.results[0].value;

    const stored = await db.getRepository(MessageBatch).findOneByOrFail({ id: batch.id });
    expect(stored.results[0].status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed WID', ['not-a-person@c.us']],
    ['an oversized WID', [`${'1'.repeat(65)}@c.us`]],
    ['an oversized list', Array.from({ length: 1025 }, () => '62811@c.us')],
    ['a sparse list', new Array<string>(1)],
  ])('refuses a hook rewrite with %s', async (_label, mentions) => {
    hooks.register('moderation', 'message:sending', () =>
      Promise.resolve({ continue: true, data: { input: { text: 'Hi', mentions } } }),
    );
    const processing = jest.spyOn(bulk as unknown as { processBatch: () => Promise<void> }, 'processBatch');
    const batch = await bulk.createBatch('s1', {
      messages: [{ chatId: '120363000000000000@g.us', type: 'text', content: { text: 'Hi' } }],
    });
    await processing.mock.results[0].value;

    const stored = await db.getRepository(MessageBatch).findOneByOrFail({ id: batch.id });
    expect(stored.results[0].status).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });
});
