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

// An edit the guard lets through is announced on `message.edited` whether or not its conditional UPDATE
// changed a row (see applyMessageEdit). These pin down what consumers receive when it changed nothing.
describe('an allowed edit whose update changes no row', () => {
  let db: DataSource;
  let repository: ReturnType<DataSource['getRepository']>;
  let emitMessageEdited: jest.Mock;
  let dispatch: jest.Mock;
  let projector: MessageMutationProjector;

  const edit = {
    messageId: 'WA1',
    chatId: '628111@c.us',
    body: 'fixed typo',
    senderId: '628111@c.us',
    from: '628111@c.us',
    to: '620000@c.us',
    fromMe: false,
    isGroup: false,
    type: 'text' as const,
    hasMedia: false,
    timestamp: 1_700_000_100,
  };

  const seed = (overrides: Partial<Message> = {}): Promise<unknown> =>
    repository.insert({
      sessionId: 's1',
      waMessageId: 'WA1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '620000@c.us',
      direction: 'incoming' as never,
      body: 'fixed typo',
      type: 'text',
      timestamp: 1_700_000_000,
      ...overrides,
    });

  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    repository = db.getRepository(Message);
    emitMessageEdited = jest.fn();
    dispatch = jest.fn().mockResolvedValue(undefined);
    projector = new MessageMutationProjector(
      repository as never,
      { emitMessageEdited } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      new KeyedMutationQueue(),
      { error: jest.fn(), warn: jest.fn() } as unknown as LoggerService,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  const announced = (): void => {
    expect(emitMessageEdited).toHaveBeenCalledTimes(1);
    expect(emitMessageEdited).toHaveBeenCalledWith('s1', edit);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('s1', 'message.edited', edit);
  };

  // A message older than the gateway's history has no row, yet a consumer may hold its own copy of it.
  it('announces an edit of a message with no stored row, and writes no row for it', async () => {
    projector.applyMessageEditQueued('s1', edit);
    await settle();

    announced();
    expect(await repository.count()).toBe(0);
  });

  it('announces an edit that repeats the stored text, without marking the row edited', async () => {
    await seed({ metadata: { quotedMessage: { id: 'WA0', body: 'earlier' } } });
    projector.applyMessageEditQueued('s1', edit);
    await settle();

    announced();
    const row = await repository.findOneByOrFail({ waMessageId: 'WA1' });
    expect(row.body).toBe('fixed typo');
    expect(row.metadata).toEqual({ quotedMessage: { id: 'WA0', body: 'earlier' } });
  });

  // The UPDATE already skips a revoked row; the announcement must skip it too, or consumers that received
  // message.revoked are handed the text the sender deleted.
  it('does not announce an edit that reaches a revoked message', async () => {
    await seed({ body: '', type: 'revoked', metadata: null as never });
    projector.applyMessageEditQueued('s1', edit);
    await settle();

    const row = await repository.findOneByOrFail({ waMessageId: 'WA1' });
    expect(row.type).toBe('revoked');
    expect(row.body).toBe('');
    expect(emitMessageEdited).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
