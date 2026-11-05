import { DataSource, Repository } from 'typeorm';
import { MessageService } from './message.service';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';

/**
 * whatsapp-web.js stores a message under its serialized id (`<fromMe>_<chat>_<id>`), and its delete accepts either
 * that id or the bare key id. docs/06 promises that after the engine delete the stored body and metadata are
 * cleared. A delete for this account only emits no engine revoke, so this request is the only writer that can clear
 * the row, and it has to name the row by the id it is stored under: the id the engine says it deleted, and the one
 * the caller typed, which a row kept from an earlier Baileys era is stored under.
 */
describe('POST messages/delete on whatsapp-web.js', () => {
  const CHAT = '628111222333@c.us';
  const OTHER_CHAT = '628999888777@c.us';
  const KEY = '3EB0AABBCCDDEEFF';
  const FULL = `true_${CHAT}_${KEY}`;
  // Ids that only resemble the key or the full id: a longer key, the same key in another case, the same key in
  // another chat. SQLite compares a LIKE pattern without regard to case, so a pattern match would take the second.
  const LONGER_KEY = `true_${CHAT}_${KEY}2`;
  const LOWER_CASE_KEY = `true_${CHAT}_${KEY.toLowerCase()}`;
  const OTHER_CHATS_ROW = `false_${OTHER_CHAT}_${KEY}`;
  const BARE_LONGER_KEY = `${KEY}9`;
  const SIMILAR = [LONGER_KEY, LOWER_CASE_KEY, OTHER_CHATS_ROW, BARE_LONGER_KEY];

  let ds: DataSource;
  let messages: Repository<Message>;
  let service: MessageService;
  let engine: { deleteMessage: jest.Mock };

  const stored = (waMessageId: string, chatId = CHAT) => ({
    sessionId: 's1',
    waMessageId,
    chatId,
    from: '628999@c.us',
    to: chatId,
    body: 'the text the account took back',
    type: 'text',
    direction: MessageDirection.OUTGOING,
    metadata: { media: { mimetype: 'image/jpeg', data: 'QkFTRTY0' } },
  });

  const clearedIds = async (): Promise<string[]> =>
    (await messages.find({ where: { type: 'revoked' }, order: { waMessageId: 'ASC' } })).map(row => row.waMessageId);

  const deleteFor = (messageId: string, forEveryone = false) =>
    service.deleteMessage('s1', { chatId: CHAT, messageId, forEveryone });

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await ds.initialize();
    messages = ds.getRepository(Message);
    await messages.insert(stored(FULL));
    await messages.insert(SIMILAR.map(id => stored(id, id === OTHER_CHATS_ROW ? OTHER_CHAT : CHAT)));
    const engines = new EngineRegistry();
    // As the whatsapp-web.js adapter answers once it has deleted the message it matched in the chat.
    engine = { deleteMessage: jest.fn().mockResolvedValue(FULL) };
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) } as unknown as HookManager;
    const projector = new MessageProjector(
      messages,
      ds.getRepository(Session),
      engines,
      {} as EventsGateway,
      { dispatch: jest.fn() } as unknown as WebhookService,
      hooks,
      {} as StatusStoreService,
      {} as SessionLidResolver,
    );
    service = new MessageService(messages, engines, projector, hooks, {} as never, {} as never, {} as never);
  });

  afterEach(() => ds.destroy());

  it('clears the stored row when the full key is given', async () => {
    await deleteFor(FULL);

    expect(engine.deleteMessage).toHaveBeenCalledWith(CHAT, FULL, false);
    expect(await clearedIds()).toEqual([FULL]);
  });

  it('clears the stored row of a message deleted for this account only when the bare key id is given', async () => {
    await deleteFor(KEY);

    expect(engine.deleteMessage).toHaveBeenCalledWith(CHAT, KEY, false);
    const row = await messages.findOneByOrFail({ waMessageId: FULL });
    expect({ type: row.type, body: row.body, metadata: row.metadata }).toEqual({
      type: 'revoked',
      body: '',
      metadata: null,
    });
  });

  it('clears the stored row of a message deleted for everyone by the bare key id', async () => {
    await deleteFor(KEY, true);

    expect(await clearedIds()).toEqual([FULL]);
  });

  it('still clears a row kept under the bare key id from an earlier engine', async () => {
    await messages.insert(stored(KEY));

    await deleteFor(KEY);

    expect(await clearedIds()).toEqual([FULL, KEY].sort());
  });

  it('clears only the row kept under the bare key id when the engine names no other id', async () => {
    await messages.insert(stored(KEY));
    engine.deleteMessage.mockResolvedValue(undefined);

    await deleteFor(KEY);

    expect(await clearedIds()).toEqual([KEY]);
  });

  it('clears only the row of the id it is given when the engine names that same id', async () => {
    await messages.insert(stored(KEY));

    await deleteFor(FULL);

    expect(await clearedIds()).toEqual([FULL]);
  });

  it('leaves rows whose ids only resemble the key alone', async () => {
    await deleteFor(KEY);

    const untouched = await messages.find({ where: { type: 'text' } });
    expect(untouched.map(row => row.waMessageId).sort()).toEqual([...SIMILAR].sort());
    expect(untouched.every(row => row.body === 'the text the account took back')).toBe(true);
  });

  it('leaves a row of another chat alone even when the engine names its id', async () => {
    engine.deleteMessage.mockResolvedValue(OTHER_CHATS_ROW);

    await deleteFor(KEY);

    expect(await clearedIds()).toEqual([]);
  });

  it.each([
    ['an empty id', ''],
    ['an object', {}],
    ['a number', 7],
  ])('ignores an engine answer that is %s', async (_name, answer) => {
    await messages.insert(stored(KEY));
    engine.deleteMessage.mockResolvedValue(answer);

    await deleteFor(KEY);

    expect(await clearedIds()).toEqual([KEY]);
  });
});
