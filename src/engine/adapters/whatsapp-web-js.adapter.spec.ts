import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';

/**
 * Delegation + readiness-gate smoke test (Tier 3 #9).
 *
 * The adapter was split into concern-scoped sub-adapters that reach the client
 * through ctx.requireClient(). Without initialize() the client is null, so
 * every delegated operation must surface the same `WhatsApp client is not
 * ready` error the monolithic adapter threw. This proves all sub-adapters are
 * wired to the shared context and the gate is preserved across the split.
 */
describe('WhatsAppWebJsAdapter (delegation + readiness gate)', () => {
  let adapter: WhatsAppWebJsAdapter;

  beforeEach(() => {
    adapter = new WhatsAppWebJsAdapter({
      sessionId: 'test-session',
      sessionDataPath: './data/test-sessions',
    });
  });

  it('starts disconnected with no client', () => {
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(adapter.getQRCode()).toBeNull();
    expect(adapter.getPhoneNumber()).toBeNull();
    expect(adapter.getPushName()).toBeNull();
  });

  const NOT_READY = 'WhatsApp client is not ready';

  // One representative call per concern sub-adapter — each must reject through
  // the shared requireClient() gate when the engine is not READY.
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['messaging.sendTextMessage', () => adapter.sendTextMessage('c@c.us', 'hi')],
    ['messaging.sendImageMessage', () => adapter.sendImageMessage('c@c.us', { mimetype: 'image/png', data: 'x' })],
    ['messaging.replyToMessage', () => adapter.replyToMessage('c@c.us', 'q', 'hi')],
    ['messaging.forwardMessage', () => adapter.forwardMessage('a@c.us', 'b@c.us', 'm')],
    ['messaging.reactToMessage', () => adapter.reactToMessage('c@c.us', 'm', '👍')],
    ['messaging.getMessageReactions', () => adapter.getMessageReactions('c@c.us', 'm')],
    ['messaging.deleteMessage', () => adapter.deleteMessage('c@c.us', 'm')],
    ['contacts.getContacts', () => adapter.getContacts()],
    ['contacts.getContactById', () => adapter.getContactById('c@c.us')],
    ['contacts.checkNumberExists', () => adapter.checkNumberExists('123')],
    ['contacts.blockContact', () => adapter.blockContact('c@c.us')],
    ['groups.getGroups', () => adapter.getGroups()],
    ['groups.getGroupInfo', () => adapter.getGroupInfo('g@g.us')],
    ['groups.createGroup', () => adapter.createGroup('g', ['1'])],
    ['groups.addParticipants', () => adapter.addParticipants('g@g.us', ['1'])],
    ['groups.getGroupInviteCode', () => adapter.getGroupInviteCode('g@g.us')],
    ['labels.getLabels', () => adapter.getLabels()],
    ['labels.getChatLabels', () => adapter.getChatLabels('c@c.us')],
    ['labels.addLabelToChat', () => adapter.addLabelToChat('c@c.us', 'l')],
    ['channels.getSubscribedChannels', () => adapter.getSubscribedChannels()],
    ['channels.getChannelById', () => adapter.getChannelById('ch')],
    ['channels.subscribeToChannel', () => adapter.subscribeToChannel('code')],
    ['channels.getChannelMessages', () => adapter.getChannelMessages('ch')],
    ['statuses.getContactStatuses', () => adapter.getContactStatuses()],
    ['statuses.postTextStatus', () => adapter.postTextStatus('hi')],
    ['catalog.getCatalog', () => adapter.getCatalog()],
    ['catalog.getProducts', () => adapter.getProducts()],
    ['catalog.sendProduct', () => adapter.sendProduct('c@c.us', 'p')],
  ];

  cases.forEach(([name, call]) => {
    it(`${name} rejects with not-ready when engine is not READY`, async () => {
      await expect(call()).rejects.toThrow(NOT_READY);
    });
  });
});
