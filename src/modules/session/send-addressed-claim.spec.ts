import { randomUUID } from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import type { LoggerService } from '../../common/services/logger.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { EditSlot } from './message-change-park';
import { MessageMutationProjector } from './message-mutation-projector';

/**
 * An API send addressed to a phone id that went out to the contact's lid has its row filed under the phone id, and the
 * lid it went to is written with the message id, in one statement. A change that names the message before that
 * statement finds no row to judge, and its write may land only on a row that carries its own claim: the send's row is
 * such a row by either chat. Runs on SQLite, and on the postgres:16 service when DATABASE_TYPE=postgres.
 */
describe('a change judged before the row of the API send it names has its id', () => {
  const PHONE = '551187654321@c.us';
  const LID = '484848484848@lid';
  let db: DataSource;
  let repository: Repository<Message>;
  let projector: MessageMutationProjector;
  let rowId: string;

  /** The send's SENT write: its id, and the lid the engine delivered it to. */
  const sentWrite = (
    engineRef: Message['engineRef'] = {
      chatId: LID,
      direction: MessageDirection.OUTGOING,
      addressed: true,
    },
  ) =>
    repository.update(
      { id: rowId, status: MessageStatus.PENDING },
      { waMessageId: 'OUT-1', status: MessageStatus.SENT, engineRef },
    );
  const stored = () => repository.findOneByOrFail({ id: rowId });
  const reactions = async () => ((await stored()).metadata as { reactions?: Record<string, string> } | null)?.reactions;
  const react = async (chatId: string, engineRef?: Message['engineRef']): Promise<void> => {
    const judge = { kind: 'reaction' as const, chatId };
    const verdict = await projector.storedRowVerdict('s1', 'OUT-1', judge);
    expect(verdict).toMatchObject({ exists: false, reason: null });
    await sentWrite(engineRef);
    await projector.writeJudgedReactions('s1', 'OUT-1', { [chatId]: '+' }, judge, verdict);
  };

  beforeEach(async () => {
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `addressed_${randomUUID().replace(/-/g, '')}`,
            entities: [Message],
            synchronize: false,
          }
        : { type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true },
    );
    await db.initialize();
    if (db.options.type === 'postgres') {
      await db.query(`CREATE SCHEMA "${db.options.schema}"`);
      await db.synchronize();
    }
    repository = db.getRepository(Message);
    projector = new MessageMutationProjector(
      repository,
      new Proxy({}, { get: () => () => undefined }) as unknown as EventsGateway,
      { changeMessageCopies: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      new KeyedMutationQueue(),
      { error: jest.fn(), warn: jest.fn() } as unknown as LoggerService,
    );
    rowId = (
      await repository.save(
        repository.create({
          sessionId: 's1',
          chatId: PHONE,
          from: '628000000000@c.us',
          to: PHONE,
          body: 'hello',
          type: 'text',
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.PENDING,
        }),
      )
    ).id;
  });

  afterEach(async () => {
    if (db.options.type === 'postgres') await db.query(`DROP SCHEMA "${db.options.schema}" CASCADE`);
    await db.destroy();
  });

  it.each([
    ['the lid it went to', LID],
    ['the phone id its caller addressed', PHONE],
  ])('lands a reaction naming %s', async (_chat, chatId) => {
    await react(chatId);

    expect(await reactions()).toEqual({ [chatId]: '+' });
  });

  it('lands an edit naming the lid it went to', async () => {
    const judge = { kind: 'edit' as const, chatId: LID, fromMe: true };
    const verdict = await projector.storedRowVerdict('s1', 'OUT-1', judge);
    await sentWrite();
    const slot: EditSlot = { body: 'edited on the phone', judge, mark: 'changed', announceText: false };

    await projector.writeEdit('s1', 'OUT-1', slot, false, verdict);

    expect(await stored()).toMatchObject({ body: 'edited on the phone', metadata: { edited: true } });
  });

  it('lands none from a third chat, nor from the contact as the author', async () => {
    await react('999999999999@lid');
    const judge = { kind: 'edit' as const, chatId: LID, fromMe: false };
    const verdict = await projector.storedRowVerdict('s1', 'OUT-1', judge);
    await projector.writeEdit(
      's1',
      'OUT-1',
      { body: 'by the contact', judge, mark: 'changed', announceText: false },
      false,
      verdict,
    );

    expect(await stored()).toMatchObject({ body: 'hello', metadata: null });
  });

  it('lands none naming the chat a message:sent handler moved the row away from', async () => {
    await react(LID, { chatId: LID, direction: MessageDirection.OUTGOING });

    expect(await reactions()).toBeUndefined();
  });
});
