import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';

// The library's own page code, which `LoadUtils` installs as `window.WWebJS`, and its own `Message.pin` and `unpin`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils') as { LoadUtils: () => void };
const { Message } = wwebjs as unknown as { Message: { prototype: object } };

/**
 * Pinning a message is a send of WhatsApp Web's own `WAWebSendPinMessageAction.sendPinInChatMsg`, and the sender has
 * changed shape. whatsapp-web.js calls it with three positional arguments, `(message, action, duration)`, which the
 * builds up to 2.3000.1050403604 declare (four positional parameters). The builds from 2.3000.1052565782 take ONE
 * options object, `{ ack, msg, pinExpiryDurationOption, pinType }`, so the library handed the message over as the
 * options object, and the sender died reading the `id` of its undefined `msg` before it sent anything: both routes
 * answered a bare 500 on every such build. The adapter now asks the page what the sender takes and calls it that way.
 *
 * The page below behaves as build 2.3000.1054966512-alpha does, read off its scripts: `sendPinInChatMsg(t)` reads
 * `t.msg`, `t.pinType` and `t.pinExpiryDurationOption`, resolves the send result when WhatsApp took the pin, resolves
 * nothing for a pin type it does not know and throws a plain `PinInChat send Error` when the send did not go through;
 * `WAWebPinMsgConstants.getPinExpiryOption` maps seconds to the option and throws for any other duration;
 * `Message$PinInChatMessage$Type` is `{ UNKNOWN_TYPE: 0, PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 }`. The control is the older
 * layout, where the sender takes `(msg, pinType, option, ack)` and the library's call works. The library's own page
 * function and `Message.pin` run against both, so what is asserted is what the library does there.
 */
describe('pinning and unpinning a message on each WhatsApp Web layout', () => {
  const CHAT = '628111@c.us';
  const MESSAGE_ID = 'true_628111@c.us_ABC';
  const DAY = 86_400;
  const g = globalThis as unknown as { window?: Record<string, unknown> & { WWebJS?: Record<string, unknown> } };

  afterEach(() => {
    delete g.window;
  });

  const OPTIONS: Record<number, string> = {
    5: 'FiveSeconds',
    15: 'FifteenSeconds',
    60: 'OneMinute',
    [DAY]: 'OneDay',
    [7 * DAY]: 'SevenDays',
    [30 * DAY]: 'ThirtyDays',
    0: 'Never',
  };
  const SECONDS = Object.fromEntries(Object.entries(OPTIONS).map(([seconds, option]) => [option, Number(seconds)]));

  interface Sent {
    msg: unknown;
    pinType: unknown;
    option?: unknown;
    duration: number;
  }

  interface Page {
    /** The older layout, whose sender takes the positional arguments the library passes. */
    positional?: boolean;
    /** Module names this build does not define: Meta's `require` throws for them. */
    without?: string[];
    /** Module names `require` answers `undefined` for, as it does from a page.evaluate with no guard active. */
    undefinedFor?: string[];
    /** The send does not go through. */
    refuse?: boolean;
    /** The message is in the page's store but not in its collection. */
    storeOnly?: boolean;
    /** The page has no such message at all. */
    unknownMessage?: boolean;
    /** What the sender throws instead of sending. */
    breakWith?: Error;
    /** Replaces the sender (an arity the adapter does not know). */
    sender?: unknown;
    /** Members the build does not export. */
    lacking?: { constants?: string[]; sender?: string[] };
  }

  /** WhatsApp Web with the pin modules of one layout, and the library's helpers installed on top of it. */
  const installPage = (page: Page = {}) => {
    const sent: Sent[] = [];
    const constants: Record<string, unknown> = {
      PIN_STATE: { INVALID: 0, PIN: 1, UNPIN: 2 },
      PinExpiryDurationOption: Object.fromEntries(Object.values(OPTIONS).map(option => [option, option])),
      DEFAULT_PIN_EXPIRY_DURATION_OPTION: 'SevenDays',
      getPinExpiryDuration: (option: string) => SECONDS[option],
      getPinExpiryOption: (seconds: number) => {
        if (!(seconds in OPTIONS)) throw new Error('Unexpeded pin expiry duration');
        return OPTIONS[seconds];
      },
    };
    const original = constants.getPinExpiryDuration;
    const send = (msg: { id: unknown }, pinType: number, option?: string) => {
      // WAWebFrontendMsgGetters.getChat(msg) reads msg.id: handed no message, the sender dies here.
      void msg.id;
      let duration: number;
      if (pinType === 1) {
        duration = (constants.getPinExpiryDuration as (option: string) => number)(
          option ?? (constants.DEFAULT_PIN_EXPIRY_DURATION_OPTION as string),
        );
      } else if (pinType === 2) {
        duration = 0;
      } else {
        return Promise.resolve(null);
      }
      if (page.breakWith) return Promise.reject(page.breakWith);
      if (page.refuse) return Promise.reject(new Error('PinInChat send Error'));
      sent.push({ msg, pinType, option, duration });
      return Promise.resolve({ messageSendResult: 'OK' });
    };
    // One options object, as the pinned build declares it; the older layout declares four positional parameters.
    // The arity is what the adapter reads, so the trailing parameter stays although nothing uses it.
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const sender = page.positional
      ? (msg: { id: unknown }, pinType: number, option?: string, _ack?: unknown) => send(msg, pinType, option)
      : (t: { ack?: unknown; msg: { id: unknown }; pinExpiryDurationOption?: string; pinType: number }) =>
          send(t.msg, t.pinType, t.pinExpiryDurationOption);
    /* eslint-enable @typescript-eslint/no-unused-vars */
    const model = { id: { _serialized: MESSAGE_ID }, page: 'model' };
    const modules: Record<string, unknown> = {
      WAWebSendPinMessageAction: {
        sendPinInChatMsg: page.sender ?? sender,
        resendPinInChatMsg: jest.fn(),
        getMsgJson: jest.fn(),
      },
      WAWebPinMsgConstants: constants,
      'WAWebProtobufsE2E.pb': { Message$PinInChatMessage$Type: { UNKNOWN_TYPE: 0, PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 } },
      WAWebCollections: {
        Msg: {
          get: (id: string) => (id === MESSAGE_ID && !page.storeOnly && !page.unknownMessage ? model : undefined),
          getMessagesById: (ids: string[]) =>
            Promise.resolve({ messages: ids.includes(MESSAGE_ID) && !page.unknownMessage ? [model] : [] }),
        },
      },
    };
    for (const name of page.lacking?.constants ?? []) delete constants[name];
    for (const name of page.lacking?.sender ?? [])
      delete (modules.WAWebSendPinMessageAction as Record<string, unknown>)[name];
    for (const name of page.without ?? []) delete modules[name];
    g.window = {
      require: (name: string) => {
        if (page.undefinedFor?.includes(name)) return undefined;
        if (!(name in modules)) throw new Error(`Requiring unknown module "${name}"`);
        return modules[name];
      },
    };
    LoadUtils();
    return { sent, model, constants, original };
  };

  /** A ready adapter whose chat holds one message: the library's own `Message`, which pins through the page. */
  const adapterOnThatPage = (inWindow = true) => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const client = {
      getChatById: jest.fn(),
      pupPage: {
        evaluate: (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => Promise.resolve().then(() => fn(...a)),
      },
    };
    const message = Object.assign(Object.create(Message.prototype) as object, {
      client,
      id: { _serialized: MESSAGE_ID, id: 'ABC' },
    });
    client.getChatById.mockResolvedValue({ fetchMessages: jest.fn().mockResolvedValue(inWindow ? [message] : []) });
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  describe('on the layout whose sender takes one options object, as the pinned build does', () => {
    it.each([
      [DAY, 'OneDay'],
      [7 * DAY, 'SevenDays'],
      [30 * DAY, 'ThirtyDays'],
    ])(
      'pins for %s seconds with the page option %s, and leaves getPinExpiryDuration alone',
      async (seconds, option) => {
        const page = installPage();

        await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, seconds)).resolves.toBeUndefined();

        expect(page.sent).toEqual([{ msg: page.model, pinType: 1, option, duration: seconds }]);
        expect(page.constants.getPinExpiryDuration).toBe(page.original);
      },
    );

    it('pins a message the bare id names, and a message only the store holds', async () => {
      const page = installPage({ storeOnly: true });

      await expect(adapterOnThatPage().pinMessage(CHAT, 'ABC', DAY)).resolves.toBeUndefined();

      expect(page.sent).toEqual([{ msg: page.model, pinType: 1, option: 'OneDay', duration: DAY }]);
    });

    it('unpins with the unpin type and no duration option', async () => {
      const page = installPage();

      await expect(adapterOnThatPage().unpinMessage(CHAT, MESSAGE_ID)).resolves.toBeUndefined();

      expect(page.sent).toEqual([{ msg: page.model, pinType: 2, option: undefined, duration: 0 }]);
      expect(page.constants.getPinExpiryDuration).toBe(page.original);
    });

    it('answers the 403 when WhatsApp did not take the pin or the unpin', async () => {
      installPage({ refuse: true });

      const pin = await adapterOnThatPage()
        .pinMessage(CHAT, MESSAGE_ID, DAY)
        .catch((e: unknown) => e);
      const unpin = await adapterOnThatPage()
        .unpinMessage(CHAT, MESSAGE_ID)
        .catch((e: unknown) => e);

      expect(pin).toBeInstanceOf(EngineRefusedError);
      expect((pin as Error).message).toMatch(/the pin of message .* was rejected/);
      expect(unpin).toBeInstanceOf(EngineRefusedError);
      expect((unpin as Error).message).toMatch(/the unpin of message .* was rejected/);
    });

    it('answers the 403 for a duration the page has no option for, without sending', async () => {
      const page = installPage();

      await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, 7_200)).rejects.toBeInstanceOf(EngineRefusedError);
      expect(page.sent).toEqual([]);
    });

    it('answers the 403 when the page has no such message, without sending', async () => {
      const page = installPage({ unknownMessage: true });

      await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, DAY)).rejects.toBeInstanceOf(EngineRefusedError);
      await expect(adapterOnThatPage().unpinMessage(CHAT, MESSAGE_ID)).rejects.toBeInstanceOf(EngineRefusedError);
      expect(page.sent).toEqual([]);
    });

    it('answers the 404 for a message outside the fetch window, without asking the page', async () => {
      const page = installPage();

      await expect(adapterOnThatPage(false).pinMessage(CHAT, MESSAGE_ID, DAY)).rejects.toBeInstanceOf(
        MessageNotFoundError,
      );
      await expect(adapterOnThatPage(false).unpinMessage(CHAT, MESSAGE_ID)).rejects.toBeInstanceOf(
        MessageNotFoundError,
      );
      expect(page.sent).toEqual([]);
    });

    it('keeps any other failure of the sender as it was', async () => {
      const failure = new TypeError('something inside the sender');
      installPage({ breakWith: failure });

      await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, DAY)).rejects.toBe(failure);
      await expect(adapterOnThatPage().unpinMessage(CHAT, MESSAGE_ID)).rejects.toBe(failure);
    });

    it('unpins on a build whose option mapper is gone, which an unpin does not need', async () => {
      const page = installPage({ lacking: { constants: ['getPinExpiryOption'] } });

      await expect(adapterOnThatPage().unpinMessage(CHAT, MESSAGE_ID)).resolves.toBeUndefined();
      await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, DAY)).rejects.toBeInstanceOf(
        EngineNotSupportedError,
      );
      expect(page.sent).toHaveLength(1);
    });
  });

  describe('on the layout whose sender takes positional arguments (the control)', () => {
    it.each([DAY, 7 * DAY, 30 * DAY])('still pins through the library for %s seconds', async seconds => {
      const page = installPage({ positional: true });

      await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, seconds)).resolves.toBeUndefined();

      // The library replaces the page's duration function for the send, so the page pins for the seconds it was given.
      expect(page.sent.map(({ msg, pinType, duration }) => ({ msg, pinType, duration }))).toEqual([
        { msg: page.model, pinType: 1, duration: seconds },
      ]);
      // And it puts the page's own function back once the send worked.
      expect(page.constants.getPinExpiryDuration).toBe(page.original);
    });

    it('still unpins through the library', async () => {
      const page = installPage({ positional: true });

      await expect(adapterOnThatPage().unpinMessage(CHAT, MESSAGE_ID)).resolves.toBeUndefined();

      expect(page.sent.map(({ msg, pinType, duration }) => ({ msg, pinType, duration }))).toEqual([
        { msg: page.model, pinType: 2, duration: 0 },
      ]);
    });

    it('keeps the 404 for a message outside the window', async () => {
      installPage({ positional: true });

      await expect(adapterOnThatPage(false).pinMessage(CHAT, MESSAGE_ID, DAY)).rejects.toBeInstanceOf(
        MessageNotFoundError,
      );
    });
  });

  describe('on a build with no sender this adapter can call', () => {
    const cases: Array<[string, Page]> = [
      ['the sender module is not defined (require throws)', { without: ['WAWebSendPinMessageAction'] }],
      ['the sender module answers undefined', { undefinedFor: ['WAWebSendPinMessageAction'] }],
      ['the module has no sender', { lacking: { sender: ['sendPinInChatMsg'] } }],
      ['the sender takes no parameter', { sender: () => Promise.resolve({ messageSendResult: 'OK' }) }],
      [
        'the sender takes two parameters',
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        { sender: (_msg: unknown, _options: unknown) => Promise.resolve({ messageSendResult: 'OK' }) },
      ],
      ['the pin type enum is not defined', { without: ['WAWebProtobufsE2E.pb'] }],
      ['the pin type enum answers undefined', { undefinedFor: ['WAWebProtobufsE2E.pb'] }],
      ['the constants module is not defined', { without: ['WAWebPinMsgConstants'] }],
      ['the constants module answers undefined', { undefinedFor: ['WAWebPinMsgConstants'] }],
      ['the message collection is not defined', { without: ['WAWebCollections'] }],
    ];

    it.each(cases)('answers 501 for a pin when %s, before anything is sent', async (_case, page) => {
      const installed = installPage(page);

      const attempt = adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, DAY);

      await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
      await expect(attempt).rejects.toThrow(/pinMessage\(no compatible pin sender on this build\)/);
      expect(installed.sent).toEqual([]);
    });

    it.each(
      cases.filter(
        ([, page]) =>
          !page.without?.includes('WAWebPinMsgConstants') && !page.undefinedFor?.includes('WAWebPinMsgConstants'),
      ),
    )('answers 501 for an unpin when %s, before anything is sent', async (_case, page) => {
      const installed = installPage(page);

      const attempt = adapterOnThatPage().unpinMessage(CHAT, MESSAGE_ID);

      await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
      await expect(attempt).rejects.toThrow(/unpinMessage\(no compatible pin sender on this build\)/);
      expect(installed.sent).toEqual([]);
    });

    // A document that has not defined `require` yet is a page that is reloading, not a build without the sender.
    it('lets a document without require answer the retryable 409', async () => {
      installPage();
      g.window = {};

      await expect(adapterOnThatPage().pinMessage(CHAT, MESSAGE_ID, DAY)).rejects.toBeInstanceOf(EngineNotReadyError);
    });
  });
});
