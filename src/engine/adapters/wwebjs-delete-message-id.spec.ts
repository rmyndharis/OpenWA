import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import type { WwebjsEngineHost } from './wwebjs-host';

/**
 * whatsapp-web.js finds the message to delete by its serialized id or by the bare key id, but keys it by the
 * serialized one. The caller needs that id to clear the stored copy, so the delete resolves it, with the chat the
 * message is stored under as the inbound mapper derives it.
 */
describe('whatsapp-web.js deleteMessage resolves the id the deleted message is keyed by', () => {
  const CHAT = '628111@c.us';
  const SELF = '628000@c.us';
  const KEY = '3EB0AABBCCDDEEFF';
  const FULL = `true_${CHAT}_${KEY}`;

  function messagingWith(id: Record<string, unknown>, sides = { fromMe: true, from: SELF, to: CHAT }) {
    const del = jest.fn().mockResolvedValue(undefined);
    const chat = { fetchMessages: jest.fn().mockResolvedValue([{ id, ...sides, delete: del }]) };
    const client = { getChatById: jest.fn().mockResolvedValue(chat) };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
      config: {},
    } as unknown as WwebjsEngineHost;
    return { messaging: new WwebjsMessaging(host), del };
  }

  it('resolves the serialized id of a message found by its bare key id', async () => {
    const { messaging, del } = messagingWith({ _serialized: FULL, id: KEY });

    await expect(messaging.deleteMessage(CHAT, KEY, false)).resolves.toEqual({ id: FULL, engineChatId: CHAT });
    expect(del).toHaveBeenCalledWith(false);
  });

  it('resolves the serialized id of a message found by it', async () => {
    const { messaging, del } = messagingWith({ _serialized: FULL, id: KEY });

    await expect(messaging.deleteMessage(CHAT, FULL, true)).resolves.toEqual({ id: FULL, engineChatId: CHAT });
    expect(del).toHaveBeenCalledWith(true);
  });

  it('resolves a group message in full, with the participant it carries', async () => {
    const GROUP = '120363000000000001@g.us';
    const group = `false_${GROUP}_${KEY}_628222@c.us`;
    const { messaging } = messagingWith({ _serialized: group, id: KEY }, { fromMe: false, from: GROUP, to: SELF });

    await expect(messaging.deleteMessage(GROUP, KEY, false)).resolves.toEqual({ id: group, engineChatId: GROUP });
  });

  it('reads the id of a WhatsApp Web build that renamed the field', async () => {
    const { messaging } = messagingWith({ $1: FULL, id: KEY });

    await expect(messaging.deleteMessage(CHAT, KEY, false)).resolves.toEqual({ id: FULL, engineChatId: CHAT });
  });

  it('resolves no id when the id of the deleted message cannot be read', async () => {
    const { messaging, del } = messagingWith({ id: KEY });

    await expect(messaging.deleteMessage(CHAT, KEY, false)).resolves.toEqual({ id: undefined, engineChatId: CHAT });
    expect(del).toHaveBeenCalledTimes(1);
  });
});
