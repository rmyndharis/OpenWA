import type { Client } from 'whatsapp-web.js';
import { WwebjsChats } from './wwebjs-chats';
import { WwebjsLabels } from './wwebjs-labels';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { type WwebjsMessaging } from './wwebjs-messaging';
import type { ChatSummary } from '../interfaces/whatsapp-engine.interface';

/**
 * What whatsapp-web.js lists for a 1:1 chat WhatsApp holds under a privacy id. `ChatSummary.phone` is Baileys only
 * (the contract, the SDK types and docs/29 say so), and a chat the page gives no title is listed under its own id,
 * so a client reads a name equal to the id as no name. `getChats` and `getChatsByLabel` build a summary
 * independently and both hold to it. A change that resolves the phone here has to update those texts with it.
 */

const logger = createLogger('wwebjs-chat-privacy-id.spec');

function makeHost(client: Record<string, unknown>): WwebjsEngineHost {
  return {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
}

const LID = '262813461250072@lid';
const PHONE_ID = '628123@c.us';

// The same chat as each builder receives it: a page model (the title is formattedTitle) and a library Chat (name).
const viaGetChats = async (id: string, title: string): Promise<ChatSummary> => {
  const model = { id: { _serialized: id }, formattedTitle: title, isGroup: false, unreadCount: 0, t: 1_700_000_000 };
  const client = { pupPage: { evaluate: jest.fn().mockResolvedValue([model]) } };
  return (await new WwebjsChats(makeHost(client), {} as unknown as WwebjsMessaging).getChats())[0];
};
const viaLabel = async (id: string, name: string): Promise<ChatSummary> => {
  const entry = { id: { _serialized: id }, name, isGroup: false, unreadCount: 0, timestamp: 1_700_000_000 };
  const client = { getChatsByLabelId: jest.fn().mockResolvedValue([entry]) };
  return (await new WwebjsLabels(makeHost(client)).getChatsByLabel('1'))[0];
};

describe.each([
  ['getChats', viaGetChats],
  ['getChatsByLabel', viaLabel],
])('whatsapp-web.js %s', (_builder, list) => {
  it('lists an unnamed privacy-id chat under its own id and sends no phone', async () => {
    const summary = await list(LID, '');

    expect(summary).toMatchObject({ id: LID, name: LID, kind: 'individual' });
    expect(summary).not.toHaveProperty('phone');
  });

  it('keeps the title WhatsApp Web gives a named privacy-id chat, and sends no phone', async () => {
    const summary = await list(LID, 'Alice');

    expect(summary.name).toBe('Alice');
    expect(summary).not.toHaveProperty('phone');
  });

  it('lists an unnamed phone-keyed chat under its own id as well', async () => {
    expect(await list(PHONE_ID, '')).toMatchObject({ id: PHONE_ID, name: PHONE_ID });
  });
});
