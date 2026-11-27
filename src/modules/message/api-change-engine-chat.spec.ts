import { DataSource, Repository } from 'typeorm';
import { MessageService } from './message.service';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';

/**
 * A delete or edit through the API acts on a message the engine found in the chat its caller named, which may be
 * another form of the chat the message is stored under: the list id of a broadcast-list message Baileys keeps in
 * the chat with its sender, or the phone number of a contact the engine keys by its lid. The stored row follows the
 * change when either the chat the engine reports or the one the caller named is its chat.
 */
describe('a delete or edit through the API, judged by the chat the engine found the message in', () => {
  const SELF = '628000@c.us';
  const SENDER = '628111@c.us';
  const LIST = '1234567890@broadcast';
  const PHONE = '628222@c.us';
  const LID = '99887766@lid';

  let ds: DataSource;
  let messages: Repository<Message>;
  let service: MessageService;
  let engine: { deleteMessage: jest.Mock; editMessage: jest.Mock };
  let persisted: string[];
  let hooks: HookManager;
  let projector: MessageProjector;

  const store = (row: Partial<Message>): Promise<unknown> =>
    messages.insert({
      sessionId: 's1',
      waMessageId: 'WA-1',
      from: SELF,
      to: SELF,
      body: 'the original text',
      type: 'text',
      direction: MessageDirection.INCOMING,
      ...row,
    } as never);
  const row = (): Promise<Message> => messages.findOneByOrFail({ waMessageId: 'WA-1' });
  const lidRef = (direction: 'incoming' | 'outgoing') => ({ chatId: LID, direction: direction as MessageDirection });
  const engineFound = (engineChatId?: string): void => {
    engine.deleteMessage.mockResolvedValue(engineChatId ? { engineChatId } : undefined);
    engine.editMessage.mockResolvedValue({ id: 'WA-1', timestamp: 1, ...(engineChatId ? { engineChatId } : {}) });
  };

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    }).initialize();
    messages = ds.getRepository(Message);
    const engines = new EngineRegistry();
    engine = { deleteMessage: jest.fn(), editMessage: jest.fn() };
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    hooks = new HookManager();
    persisted = [];
    hooks.register('index', 'message:persisted', ctx => {
      persisted.push((ctx.data as { message: Message }).message.type);
      return Promise.resolve({ continue: true });
    });
    projector = new MessageProjector(
      messages,
      ds.getRepository(Session),
      engines,
      { emitMessage: jest.fn() } as unknown as EventsGateway,
      { dispatch: jest.fn() } as unknown as WebhookService,
      hooks,
      {} as StatusStoreService,
      {} as SessionLidResolver,
      undefined,
      undefined,
      undefined,
      // No pairing of the lid and the phone number is reported.
      { findPhoneForLid: jest.fn().mockResolvedValue(null) } as never,
    );
    const pacing = { assertSendAllowed: jest.fn().mockResolvedValue(undefined) };
    service = new MessageService(messages, engines, projector, hooks, {} as never, pacing as never, {} as never);
  });

  afterEach(() => ds.destroy());

  it('clears a received broadcast-list message stored with its sender when deleted by the list id', async () => {
    await store({ chatId: SENDER, from: SENDER, author: SENDER });
    engineFound(SENDER);

    await service.deleteMessage('s1', { chatId: LIST, messageId: 'WA-1' });

    expect(engine.deleteMessage).toHaveBeenCalledWith(LIST, 'WA-1', true);
    expect(await row()).toMatchObject({ chatId: SENDER, type: 'revoked', body: '' });
  });

  it('clears and edits an own message stored under the lid when the caller names the phone number', async () => {
    await store({ chatId: LID, to: LID, direction: MessageDirection.OUTGOING });
    engineFound(LID);

    await service.editMessage('s1', { chatId: PHONE, messageId: 'WA-1', body: 'edited' });
    expect(await row()).toMatchObject({ chatId: LID, body: 'edited' });

    await service.deleteMessage('s1', { chatId: PHONE, messageId: 'WA-1' });
    expect(await row()).toMatchObject({ chatId: LID, type: 'revoked', body: '' });
  });

  it('still clears and edits a row stored under the phone number the caller names when the engine reports the lid', async () => {
    // A send through the API is stored under the number its caller addressed, while Baileys keys it by the lid it
    // went to: the pairing may not be reported yet when the engine confirmed it on the spot.
    await store({ chatId: PHONE, to: PHONE, direction: MessageDirection.OUTGOING });
    engineFound(LID);

    await service.editMessage('s1', { chatId: PHONE, messageId: 'WA-1', body: 'edited' });
    expect(await row()).toMatchObject({ chatId: PHONE, body: 'edited' });

    await service.deleteMessage('s1', { chatId: PHONE, messageId: 'WA-1' });
    expect(await row()).toMatchObject({ chatId: PHONE, type: 'revoked', body: '' });
    // Once for the edit, once for the delete.
    expect(persisted).toEqual(['text', 'revoked']);
  });

  it('still clears a message from a lid that a handler filed under its phone number before engine refs were kept', async () => {
    await store({ chatId: PHONE, from: PHONE });
    engineFound(LID);

    await service.deleteMessage('s1', { chatId: PHONE, messageId: 'WA-1' });

    expect(await row()).toMatchObject({ chatId: PHONE, type: 'revoked', body: '' });
  });

  it('judges by the chat the caller named when the engine reports none', async () => {
    await store({ chatId: PHONE, to: PHONE, direction: MessageDirection.OUTGOING });
    engineFound(undefined);

    await service.editMessage('s1', { chatId: PHONE, messageId: 'WA-1', body: 'edited' });
    await service.deleteMessage('s1', { chatId: PHONE, messageId: 'WA-1' });

    expect(await row()).toMatchObject({ chatId: PHONE, type: 'revoked', body: '' });
  });

  describe('a message a hook filed under another chat', () => {
    const FILED = '628999@c.us';

    it('is cleared and edited when the engine reports the lid a phone number names, with no pairing reported', async () => {
      await store({ chatId: PHONE, to: PHONE, direction: MessageDirection.OUTGOING, engineRef: lidRef('outgoing') });
      engineFound(LID);

      await service.editMessage('s1', { chatId: PHONE, messageId: 'WA-1', body: 'edited' });
      expect(await row()).toMatchObject({ chatId: PHONE, body: 'edited' });

      await service.deleteMessage('s1', { chatId: PHONE, messageId: 'WA-1' });
      expect(await row()).toMatchObject({ chatId: PHONE, type: 'revoked' });
    });

    it('is cleared by a delete naming its list when a hook filed it under the list', async () => {
      hooks.register('lister', 'message:received', ctx =>
        Promise.resolve({ continue: true, data: { ...(ctx.data as IncomingMessage), chatId: LIST } }),
      );
      const received = {
        id: 'WA-1',
        chatId: SENDER,
        from: SENDER,
        to: SELF,
        author: SENDER,
        body: 'the original text',
      };
      await projector.handleInboundMessage('s1', engine as unknown as IWhatsAppEngine, {
        ...received,
        type: 'text',
        timestamp: 1,
        fromMe: false,
        isGroup: false,
        kind: 'individual',
      })?.settled;
      expect(await row()).toMatchObject({ chatId: LIST, type: 'text' });
      engineFound(SENDER);

      await service.deleteMessage('s1', { chatId: LIST, messageId: 'WA-1' });

      expect(await row()).toMatchObject({ chatId: LIST, type: 'revoked' });
    });

    it('is cleared by a delete naming the engine chat when the engine reports none', async () => {
      await store({ chatId: FILED, engineRef: { chatId: SENDER, direction: MessageDirection.INCOMING } });
      engineFound(undefined);

      await service.deleteMessage('s1', { chatId: SENDER, messageId: 'WA-1' });

      expect(await row()).toMatchObject({ chatId: FILED, type: 'revoked' });
    });

    it('is never changed for naming the chat it is filed under', async () => {
      await store({ chatId: FILED, engineRef: { chatId: SENDER, direction: MessageDirection.INCOMING } });
      engineFound('628777@c.us');

      await service.deleteMessage('s1', { chatId: FILED, messageId: 'WA-1' });

      expect(await row()).toMatchObject({ chatId: FILED, type: 'text', body: 'the original text' });
    });
  });

  it('leaves the row of another chat that holds the id alone', async () => {
    await store({ chatId: '628777@c.us', from: '628777@c.us' });
    engineFound(SENDER);

    await service.editMessage('s1', { chatId: SENDER, messageId: 'WA-1', body: 'edited' });
    await service.deleteMessage('s1', { chatId: SENDER, messageId: 'WA-1' });

    expect(await row()).toMatchObject({ chatId: '628777@c.us', type: 'text', body: 'the original text' });
    expect(persisted).toEqual([]);
  });
});
