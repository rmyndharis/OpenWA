import { DataSource } from 'typeorm';
import { HookManager } from '../../core/hooks';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session } from '../session/entities/session.entity';
import { BulkMessageService } from './bulk-message.service';
import { MessageBatch, BatchStatus } from './entities/message-batch.entity';
import { Message } from './entities/message.entity';
import type { MessageService } from './message.service';
import { renderTemplate, templateVariableNames } from '../../common/utils/template-render';
import type { SendPacingService } from './send-pacing.service';

describe('bulk media variable cleanup', () => {
  let db: DataSource;
  let bulk: BulkMessageService;
  let send: jest.Mock;
  let hooks: HookManager;
  const payload = 'QUJDREVG';
  const messages = () => [
    {
      chatId: '628111111111@c.us',
      type: 'image' as const,
      content: { image: { base64: '{{picture}}', mimetype: 'image/png' }, caption: 'Photo' },
      variables: { picture: payload, name: 'Alice' },
    },
  ];

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

  it.each([
    ['complete', BatchStatus.COMPLETED],
    ['cancel', BatchStatus.CANCELLED],
    ['startup', BatchStatus.FAILED],
  ] as const)('drops the media variable on %s', async (transition, terminalStatus) => {
    const repository = db.getRepository(MessageBatch);
    let batch: MessageBatch;
    if (transition === 'complete') {
      const processing = jest.spyOn(bulk as unknown as { processBatch: () => Promise<void> }, 'processBatch');
      batch = await bulk.createBatch('s1', { messages: messages() });
      await processing.mock.results[0].value;
    } else {
      batch = await repository.save({
        batchId: 'personalized',
        sessionId: 's1',
        status: BatchStatus.PENDING,
        messages: messages(),
        options: { delayBetweenMessages: 1000, randomizeDelay: false, stopOnError: false },
        progress: { total: 1, pending: 1, sent: 0, failed: 0, cancelled: 0 },
        results: [],
        currentIndex: 0,
      });
      if (transition === 'cancel') await bulk.cancelBatch('s1', batch.batchId);
      else await bulk.onApplicationBootstrap();
    }

    const stored = await repository.findOneByOrFail({ id: batch.id });
    expect(stored.status).toBe(terminalStatus);
    expect(JSON.stringify(stored.messages)).not.toContain(payload);
    expect(stored.messages[0].content).toMatchObject({ image: { mimetype: 'image/png' }, caption: 'Photo' });
    expect(stored.messages[0].variables).toEqual({ name: 'Alice' });
  });

  it('names the same variables the renderer substitutes', () => {
    for (const body of [
      '{{a}}',
      '{b}',
      '{{ c }}',
      '{{d.e-f}}',
      '{{{g}}}',
      '{ h }',
      '{{i}',
      'a {j} and {{k}}',
      'plain',
    ]) {
      const names = templateVariableNames(body);
      const vars = Object.fromEntries(names.map(name => [name, '@']));
      const rendered = renderTemplate(body, vars);
      expect(rendered.split('@').length - 1).toBe(names.length);
    }
  });
});
