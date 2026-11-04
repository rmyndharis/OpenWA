import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import type { WwebjsEngineHost } from './wwebjs-host';

/**
 * whatsapp-web.js finds the message to delete by its serialized id or by the bare key id, but keys it by the
 * serialized one. The caller needs that id to clear the stored copy, so the delete resolves it.
 */
describe('whatsapp-web.js deleteMessage resolves the id the deleted message is keyed by', () => {
  const CHAT = '628111@c.us';
  const KEY = '3EB0AABBCCDDEEFF';
  const FULL = `true_${CHAT}_${KEY}`;

  function messagingWith(id: Record<string, unknown>) {
    const del = jest.fn().mockResolvedValue(undefined);
    const chat = { fetchMessages: jest.fn().mockResolvedValue([{ id, delete: del }]) };
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

    await expect(messaging.deleteMessage(CHAT, KEY, false)).resolves.toBe(FULL);
    expect(del).toHaveBeenCalledWith(false);
  });

  it('resolves the serialized id of a message found by it', async () => {
    const { messaging, del } = messagingWith({ _serialized: FULL, id: KEY });

    await expect(messaging.deleteMessage(CHAT, FULL, true)).resolves.toBe(FULL);
    expect(del).toHaveBeenCalledWith(true);
  });

  it('resolves a group message in full, with the participant it carries', async () => {
    const group = `false_120363000000000001@g.us_${KEY}_628222@c.us`;
    const { messaging } = messagingWith({ _serialized: group, id: KEY });

    await expect(messaging.deleteMessage('120363000000000001@g.us', KEY, false)).resolves.toBe(group);
  });

  it('reads the id of a WhatsApp Web build that renamed the field', async () => {
    const { messaging } = messagingWith({ $1: FULL, id: KEY });

    await expect(messaging.deleteMessage(CHAT, KEY, false)).resolves.toBe(FULL);
  });

  it('resolves nothing when the id of the deleted message cannot be read', async () => {
    const { messaging, del } = messagingWith({ id: KEY });

    await expect(messaging.deleteMessage(CHAT, KEY, false)).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });
});
