import { DataSource } from 'typeorm';
import { Message } from '../message/entities/message.entity';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import type { LoggerService } from '../../common/services/logger.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import { MessageMutationProjector } from './message-mutation-projector';

/** Waits for `condition` between event-loop turns and fails at the deadline instead of hanging. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

/**
 * A message the session never stored has no row: a disappearing one under STORE_EPHEMERAL_MESSAGES=false, one from
 * before the session went live, one the retention removed. A change to it is announced all the same, which is why
 * the engine's own copy of such a message is not what keeps a consumer informed.
 */
describe('a change to a message that has no stored row', () => {
  let db: DataSource;
  let emitMessageEdited: jest.Mock;
  let emitMessageReaction: jest.Mock;
  let dispatch: jest.Mock;
  let projector: MessageMutationProjector;

  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    emitMessageEdited = jest.fn();
    emitMessageReaction = jest.fn();
    dispatch = jest.fn().mockResolvedValue(undefined);
    projector = new MessageMutationProjector(
      db.getRepository(Message),
      { emitMessageEdited, emitMessageReaction } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      new KeyedMutationQueue(),
      { error: jest.fn(), warn: jest.fn() } as unknown as LoggerService,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('announces an edit with its new body on the websocket and the webhook, and writes no row', async () => {
    const edit = {
      messageId: 'HIDDEN1',
      chatId: '628111@c.us',
      body: 'the edited text of a message nobody was told about',
      fromMe: false,
    };

    projector.applyMessageEditQueued('s1', edit as never);
    await until(() => dispatch.mock.calls.length === 1, 'the edit to be announced');

    expect(emitMessageEdited).toHaveBeenCalledWith('s1', edit);
    expect(dispatch).toHaveBeenCalledWith('s1', 'message.edited', edit);
    expect(await db.getRepository(Message).count()).toBe(0);
  });

  it('announces a reaction, without the list of reactions it has no row to keep, and writes no row', async () => {
    const reaction = { messageId: 'HIDDEN1', chatId: '628111@c.us', senderId: '628111@c.us', reaction: 'thumbs up' };

    projector.applyReactionQueued('s1', reaction);
    await until(() => dispatch.mock.calls.length === 1, 'the reaction to be announced');

    expect(emitMessageReaction).toHaveBeenCalledWith('s1', reaction);
    expect(dispatch).toHaveBeenCalledWith('s1', 'message.reaction', reaction);
    expect(await db.getRepository(Message).count()).toBe(0);
  });
});
