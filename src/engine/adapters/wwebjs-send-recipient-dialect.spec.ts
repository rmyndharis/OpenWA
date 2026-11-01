import { EventEmitter } from 'events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';

/**
 * A phone id is one recipient in any of its spellings: the `s.whatsapp.net` dialect the API documents for a send,
 * upper case, or a `:device` suffix. Each must be resolved like its `<phone>@c.us` form, so a contact WhatsApp
 * addresses by its lid is reached rather than refused with "No LID for user".
 */
describe('a whatsapp-web.js send to another spelling of a phone id', () => {
  const PHONE = '628111222333@c.us';
  const LID = '159442138038327@lid';
  const SENT = { id: { _serialized: 'true_159442138038327@lid_M1' }, timestamp: 1 };

  function ready(client: Record<string, unknown>): WhatsAppWebJsAdapter {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { client: unknown }).client = Object.assign(
      new EventEmitter(),
      { pupPage: new EventEmitter(), pupBrowser: new EventEmitter() },
      client,
    );
    return adapter;
  }

  // The page refuses a migrated contact's phone id and accepts its lid.
  const page = () =>
    jest.fn((to: string) => (to === LID ? Promise.resolve(SENT) : Promise.reject(new Error('No LID for user'))));

  it.each(['628111222333@s.whatsapp.net', '628111222333@C.US', '628111222333:7@s.whatsapp.net'])(
    'resolves %s to the lid and delivers',
    async chatId => {
      const sendMessage = page();
      const getNumberId = jest.fn().mockResolvedValue({ _serialized: LID });

      await expect(ready({ sendMessage, getNumberId }).sendTextMessage(chatId, 'hi')).resolves.toMatchObject({
        id: SENT.id._serialized,
      });
      expect(getNumberId).toHaveBeenCalledWith(PHONE);
      expect(sendMessage.mock.calls.map(call => call[0])).toEqual([LID]);
    },
  );

  it('re-resolves an s.whatsapp.net recipient refused with "No LID for user" and retries on the lid', async () => {
    const sendMessage = page();
    const getNumberId = jest
      .fn()
      .mockResolvedValueOnce({ _serialized: PHONE })
      .mockResolvedValueOnce({ _serialized: LID });

    await expect(
      ready({ sendMessage, getNumberId }).sendTextMessage('628111222333@s.whatsapp.net', 'hi'),
    ).resolves.toMatchObject({ id: SENT.id._serialized });
    expect(sendMessage.mock.calls.map(call => call[0])).toEqual([PHONE, LID]);
  });
});
