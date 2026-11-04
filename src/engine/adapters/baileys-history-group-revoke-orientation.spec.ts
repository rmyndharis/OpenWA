import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { DataSource, Repository } from 'typeorm';
import { BaileysHistory, BaileysHistoryHost } from './baileys-history';
import { BaileysEvents, BaileysEventsHost } from './baileys-events';
import { BaileysMessageStoreService } from './baileys-message-store.service';
import { BaileysStoredMessage } from './baileys-stored-message.entity';
import { BaileysSessionStore } from './baileys-session-store';
import { Message, MessageDirection } from '../../modules/message/entities/message.entity';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import { persistHistoryMessages } from '../../modules/session/message-history-projector';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

/**
 * A history revoke is keyed as the revoker's client wrote it. In a group, the message it names belongs to the
 * revoker when the key says `fromMe`, and to the participant the key names otherwise, which is the account itself
 * when an admin deleted the account's message. In whichever order the chunks arrive, the message ends up deleted
 * and keeps the direction and author of the message it is.
 */

const GROUP = '1@g.us';
const SELF = '628222@s.whatsapp.net';
const SELF_LID = '900222@lid';
const MEMBER = '628333@s.whatsapp.net';
const ADMIN = '628444@s.whatsapp.net';

const protocolRevoke = (target: WAMessage['key'], envelope: WAMessage['key']): WAMessage => ({
  key: envelope,
  message: { protocolMessage: { type: 0, key: target } },
  messageTimestamp: 1_700_000_100,
});

const ownMessage: WAMessage = {
  key: { id: 'M1', remoteJid: GROUP, fromMe: true },
  message: { conversation: 'mine' },
  messageTimestamp: 1_700_000_000,
};
const memberMessage: WAMessage = {
  key: { id: 'M1', remoteJid: GROUP, fromMe: false, participant: MEMBER },
  message: { conversation: 'withdrawn secret' },
  messageTimestamp: 1_700_000_000,
};
const adminRevokeOf = (participant: string): WAMessage =>
  protocolRevoke(
    { id: 'M1', remoteJid: GROUP, fromMe: false, participant },
    { id: 'R1', remoteJid: GROUP, fromMe: false, participant: ADMIN },
  );
const memberOwnRevoke = protocolRevoke(
  { id: 'M1', remoteJid: GROUP, fromMe: true },
  { id: 'R1', remoteJid: GROUP, fromMe: false, participant: MEMBER },
);

describe('Baileys history group revokes keyed from the revoker side', () => {
  let ds: DataSource;
  let repo: Repository<Message>;
  let history: BaileysHistory;
  let pending: Promise<IncomingMessage[]>[];
  let readGroupMembers: jest.Mock;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session, BaileysStoredMessage],
      synchronize: true,
    }).initialize();
    repo = ds.getRepository(Message);
    const raw = new BaileysMessageStoreService(ds.getRepository(BaileysStoredMessage));
    await ds.getRepository(Session).save({ id: 's1', name: 's1', status: SessionStatus.READY, config: {} });
    const previews = new BaileysSessionStore(undefined, 's1');
    previews.upsertChats([{ id: GROUP }]);
    pending = [];
    // A roster that shows the sender of every delete here is no admin.
    readGroupMembers = jest.fn(() => Promise.resolve([{ ids: [ADMIN, MEMBER], admin: false }]));
    const onHistory = jest.fn((messages: IncomingMessage[]) => {
      const saving = persistHistoryMessages(repo, undefined, 's1', messages, { log: jest.fn() } as never, () => true);
      pending.push(saving);
      return saving;
    });
    const host = {
      getSocket: () => ({}) as WASocket,
      getSocketOrNull: () => null,
      logger: createLogger('baileys-history-group-revoke-orientation.spec'),
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (m: unknown) => m,
          getContentType: (m: object) => Object.keys(m)[0],
          extractMessageContent: (m: unknown) => m,
          proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
        } as never),
      normalizedSelfJid: () => SELF,
      // As the adapter host does when the credentials carry the account's lid: that lid folds onto its phone.
      toNeutralJid: (jid: string) => (jid === SELF_LID ? '628222@c.us' : previews.toNeutralJid(jid)),
      extractEphemeralDuration: (msg: WAMessage) => previews.extractEphemeralDuration(msg),
      recordMessage: (msg: WAMessage, type: Parameters<BaileysSessionStore['recordMessage']>[1]) =>
        previews.recordMessage(msg, type),
      recordMessageEdit: (...args: Parameters<BaileysSessionStore['recordMessageEdit']>) =>
        previews.recordMessageEdit(...args),
      upsertContacts: () => undefined,
      getOnHistoryMessages: () => onHistory,
      getFetchDispatcher: () => undefined,
      inboundLimiter: new ConcurrencyLimiter(4),
      recordKeyLidMappings: () => undefined,
      consumeOwnSend: () => false,
      putStoredMessage: (msg: WAMessage) => raw.put('s1', msg),
      getStoredMessage: (id: string) => raw.getMessage('s1', id),
      updateStoredMessage: (id: string, change: (stored: WAMessage) => WAMessage | null) =>
        raw.update('s1', id, change),
      readGroupMembers,
    };
    const events = new BaileysEvents(host as unknown as BaileysEventsHost);
    history = new BaileysHistory({
      ...host,
      applyHistoryRevoke: (...args: Parameters<BaileysEvents['applyHistoryRevoke']>) =>
        events.applyHistoryRevoke(...args),
    } as unknown as BaileysHistoryHost);
  });

  afterEach(async () => {
    await Promise.all(pending);
    await ds.destroy();
  });

  const capture = async (messages: WAMessage[]): Promise<void> => {
    await history.captureHistoryMessages(messages);
    await Promise.all(pending);
  };
  const row = async () => {
    const stored = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
    return { type: stored.type, body: stored.body, direction: stored.direction, author: stored.author ?? null };
  };

  it('keeps the account message outgoing when an admin delete of it comes first', async () => {
    await capture([adminRevokeOf(SELF)]);
    await capture([ownMessage]);
    expect(await row()).toEqual({ type: 'revoked', body: '', direction: MessageDirection.OUTGOING, author: null });
  });

  it('clears the account message when an admin delete of it comes in a later chunk', async () => {
    await capture([ownMessage]);
    await capture([adminRevokeOf(SELF)]);
    expect(await row()).toEqual({ type: 'revoked', body: '', direction: MessageDirection.OUTGOING, author: null });
  });

  it('reads the account lid in an admin delete as the account', async () => {
    await capture([adminRevokeOf(SELF_LID)]);
    await capture([ownMessage]);
    expect(await row()).toEqual({ type: 'revoked', body: '', direction: MessageDirection.OUTGOING, author: null });
  });

  it('stores no withdrawn text when a member delete of their own message comes before it', async () => {
    await capture([memberOwnRevoke]);
    await capture([memberMessage]);
    expect(await row()).toEqual({
      type: 'revoked',
      body: '',
      direction: MessageDirection.INCOMING,
      author: '628333@c.us',
    });
  });

  it('clears a member message when their own delete of it comes in a later chunk', async () => {
    await capture([memberMessage]);
    await capture([memberOwnRevoke]);
    expect(await row()).toEqual({
      type: 'revoked',
      body: '',
      direction: MessageDirection.INCOMING,
      author: '628333@c.us',
    });
  });

  it('keeps an admin delete of another member message incoming and attributed to that member', async () => {
    await capture([adminRevokeOf(MEMBER)]);
    await capture([memberMessage]);
    expect(await row()).toEqual({
      type: 'revoked',
      body: '',
      direction: MessageDirection.INCOMING,
      author: '628333@c.us',
    });
  });

  // Today's roster says nothing of the sender's role when a delete synced from history was made, and refusing a
  // former admin's delete would keep the text that was withdrawn, so a history delete is not checked against it.
  it('applies a history delete of another member message without reading the group roster', async () => {
    await capture([memberMessage]);
    await capture([adminRevokeOf(MEMBER)]);
    expect(await row()).toEqual({
      type: 'revoked',
      body: '',
      direction: MessageDirection.INCOMING,
      author: '628333@c.us',
    });
    expect(readGroupMembers).not.toHaveBeenCalled();
  });
});
