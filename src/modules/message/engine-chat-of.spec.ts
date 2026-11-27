import { DataSource, Repository } from 'typeorm';
import { engineChatOf } from './engine-chat-of';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';

/**
 * A follow-up through the API (a reaction, an edit, a delete, a star, a pin, a forward's source) names the message by
 * the chat its caller sees it in. The row of an API send the engine delivered to the contact's LID is filed under the
 * chat its caller addressed, and the engine looks the message up in the chat it went to: only that row routes.
 */
describe('engineChatOf', () => {
  const PHONE = '551187654321@c.us';
  const LID = '484848484848@lid';
  let ds: DataSource;
  let messages: Repository<Message>;
  const thread = (chatId: string) =>
    Promise.resolve(chatId === '551187654321@s.whatsapp.net' ? [chatId, PHONE] : [chatId]);
  const store = (waMessageId: string, engineRef: Message['engineRef']) =>
    messages.insert({
      sessionId: 's1',
      waMessageId,
      chatId: PHONE,
      from: '628000000000@c.us',
      to: PHONE,
      type: 'text',
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      engineRef,
    });

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    messages = ds.getRepository(Message);
    await store('ADDRESSED', { chatId: LID, direction: MessageDirection.OUTGOING, addressed: true });
    await store('MOVED', { chatId: LID, direction: MessageDirection.OUTGOING });
    await store('PLAIN', null);
  });
  afterEach(() => ds.destroy());

  it('hands the chat an API send went to when the caller names the chat its row is filed under, in any form', async () => {
    expect(await engineChatOf(messages, 's1', PHONE, 'ADDRESSED', thread)).toBe(LID);
    expect(await engineChatOf(messages, 's1', '551187654321@s.whatsapp.net', 'ADDRESSED', thread)).toBe(LID);
  });

  it.each([
    ['a row a hook moved', PHONE, 'MOVED'],
    ['a row with no engine ref', PHONE, 'PLAIN'],
    ['the row of another chat', '628999000000@c.us', 'ADDRESSED'],
    ['an id with no row', PHONE, 'NONE'],
    ['another session', PHONE, 'ADDRESSED', 's2'],
  ])('hands the caller its own chat for %s', async (_case, chatId, waMessageId, sessionId = 's1') => {
    expect(await engineChatOf(messages, sessionId, chatId, waMessageId, thread)).toBe(chatId);
  });

  it('hands the caller its own chat when the row cannot be read', async () => {
    jest.spyOn(messages, 'findOne').mockRejectedValueOnce(new Error('database is locked'));

    expect(await engineChatOf(messages, 's1', PHONE, 'ADDRESSED', thread)).toBe(PHONE);
  });
});
