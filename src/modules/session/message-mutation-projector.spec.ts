import { DataSource } from 'typeorm';
import { Message } from '../message/entities/message.entity';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import type { LoggerService } from '../../common/services/logger.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import { MessageMutationProjector } from './message-mutation-projector';

const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
};

// The stored copy of a reaction is best-effort; the notification is not (see applyReaction).
describe('a reaction whose stored copy cannot be written', () => {
  let db: DataSource;
  let emitMessageReaction: jest.Mock;
  let dispatch: jest.Mock;
  let projector: MessageMutationProjector;
  let logger: { error: jest.Mock; warn: jest.Mock };

  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    const repository = db.getRepository(Message);
    await repository.insert({
      sessionId: 's1',
      waMessageId: 'WA1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '620000@c.us',
      direction: 'incoming' as never,
      body: 'hello',
      type: 'text',
      timestamp: 1_700_000_000,
    });
    jest.spyOn(repository, 'update').mockRejectedValue(new Error('database is locked'));
    emitMessageReaction = jest.fn();
    dispatch = jest.fn().mockResolvedValue(undefined);
    logger = { error: jest.fn(), warn: jest.fn() };
    projector = new MessageMutationProjector(
      repository,
      { emitMessageReaction } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      new KeyedMutationQueue(),
      logger as unknown as LoggerService,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('is still announced, without the full list of reactions it could not compute', async () => {
    const event = { messageId: 'WA1', chatId: '628111@c.us', senderId: '628111@c.us', reaction: '👍' };
    projector.applyReactionQueued('s1', event);
    await settle();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(emitMessageReaction).toHaveBeenCalledWith('s1', event);
    expect(dispatch).toHaveBeenCalledWith('s1', 'message.reaction', event);
  });
});
