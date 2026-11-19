import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

// The library's own page code: the functions it ships into WhatsApp Web, which `LoadUtils` installs as `window.WWebJS`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils') as { LoadUtils: () => void };
const { Client, Channel } = wwebjs as unknown as {
  Client: { prototype: object };
  Channel: new (client: unknown, data: unknown) => unknown;
};

/**
 * Deleting a channel, muting or unmuting it and unsubscribing from it are jobs of WhatsApp Web, and whatsapp-web.js
 * reads every status that a job rejects with (`ServerStatusCodeError`) as `false`, which the adapter read as a refusal: a
 * timeout, a rate limit or a server error was a 403. The channel jobs reject that class for an error of the IQ that
 * carries them and the class of the Mex query for an error of the query itself (`MexServerStatusCodeError`), which the
 * library did not catch, so that was a bare 500. The adapter now sends the same request in the page and answers by the
 * status WhatsApp Web reported. A retryable status (408, 423, 429, 5xx) is the 503 that says the operation may or may
 * not have been applied: the page sends a delete or a mute again on a 429 or a 500 and only the last error surfaces,
 * the Mex client makes a 500 of its own of a send that failed, and an unsubscription is one request whose reply may
 * not have come.
 *
 * The page below behaves as build 2.3000.1054966512-alpha does, read off its scripts: the jobs resolve when WhatsApp took
 * the request and reject the status otherwise, and the unsubscription job reports a suspended channel as a 423 with the
 * text `newsletter-suspended`. The client and the channel are the library's own, on top of the helpers it installs as
 * `window.WWebJS` (the chat store is the page's own and is replaced), so on a page that has the jobs what is asserted is
 * what the adapter does where the library's calls were.
 */
describe('a channel write that WhatsApp answers with a status', () => {
  const CHANNEL = '120363401234567890@newsletter';
  const g = globalThis as unknown as { window?: Record<string, unknown> & { WWebJS?: Record<string, unknown> } };

  afterEach(() => {
    delete g.window;
  });

  const statusError = (status: number, name = 'ServerStatusCodeError', message = `status ${status}`) =>
    Object.assign(new Error(message), { name, status, statusCode: status });

  type Answer = { resolves: undefined } | { rejects: Error };

  interface Page {
    /** What the channel job answers. */
    job?: Answer;
    /** The channel as the page's store holds it: not at all, one the account owns, or one it subscribes to. */
    channel?: 'absent' | 'owner' | 'subscriber';
    /** Module names this build does not define, and what its `require` does for one: answer `undefined` or throw. */
    without?: string[];
    unknownModule?: 'throws' | 'undefined';
  }

  const installPage = (page: Page = {}) => {
    const answer = page.job ?? { resolves: undefined };
    const job = jest.fn(() =>
      'rejects' in answer ? Promise.reject(answer.rejects) : Promise.resolve(answer.resolves),
    );
    const modules: Record<string, unknown> = {
      WAWebNewsletterDeleteAction: { deleteNewsletterAction: job },
      WAWebNewsletterUpdateUserSettingJob: { updateNewsletterUserSetting: job },
      WAWebNewsletterUnsubscribeAction: { unsubscribeFromNewsletterAction: job },
      WAJids: { toNewsletterJid: (id: string) => `jid:${id}` },
      WAWebNewsletterModelUtils: { ADMIN_NOTIFICATIONS: 'admin', MUTED_STATE: 'muted', UNMUTED_STATE: 'unmuted' },
    };
    for (const name of page.without ?? []) delete modules[name];
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) {
          if (page.unknownModule === 'undefined') return undefined;
          throw new Error(`Requiring unknown module "${name}"`);
        }
        return modules[name];
      },
    };
    LoadUtils();
    // The chat store is the page's own: the writes read the channel's model from it.
    g.window.WWebJS!.getChat = () =>
      Promise.resolve(
        page.channel === 'absent' ? null : { newsletterMetadata: { membershipType: page.channel ?? 'subscriber' } },
      );
    return job;
  };

  const adapterOnThatPage = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const client = Object.assign(Object.create(Client.prototype) as object, {
      pupPage: {
        evaluate: (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => Promise.resolve().then(() => fn(...a)),
      },
    });
    // The structure whatsapp-web.js hands out for a channel id, which carries its own mute and unmute.
    const channel = new Channel(client, {
      id: { server: 'newsletter', user: '120363401234567890', _serialized: CHANNEL },
    });
    Object.assign(client, { getChatById: jest.fn().mockResolvedValue(channel) });
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  type Write = [name: string, call: (a: WhatsAppWebJsAdapter) => Promise<void>, refusal: RegExp];
  const WRITES: Write[] = [
    ['the delete of a channel', a => a.deleteChannel(CHANNEL), /^Failed to delete channel /],
    ['the mute of a channel', a => a.muteChannel(CHANNEL, true), /^Failed to mute channel /],
    ['the unmute of a channel', a => a.muteChannel(CHANNEL, false), /^Failed to unmute channel /],
    [
      'the unsubscription from a channel',
      a => a.unsubscribeFromChannel(CHANNEL),
      /^Failed to unsubscribe from channel /,
    ],
  ];

  describe.each(WRITES)('%s', (_name, call, refusal) => {
    it('is done when WhatsApp takes it', async () => {
      installPage();

      await expect(call(adapterOnThatPage())).resolves.toBeUndefined();
    });

    it.each([401, 403, 404, 406])(
      'is a refusal with the words it always had when WhatsApp answers %i',
      async status => {
        installPage({ job: { rejects: statusError(status) } });

        const attempt = call(adapterOnThatPage());

        await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
        await expect(attempt).rejects.toThrow(refusal);
      },
    );

    // No retryable status of these writes can promise that nothing was changed: the page sends a delete or a mute again
    // on a 429 or a 500 and only the error of the last attempt surfaces, so a lost first attempt can be followed by a
    // rate limit, an outage or a refusal that hides it; a timeout answers nothing; the Mex client makes a 500 of its
    // own of a send that failed; and an unsubscription is one request whose reply may not have come. Each is the 503
    // that says the outcome is unknown, and neither a refusal nor a failure that changed nothing.
    it.each([
      ['a timeout (408)', statusError(408)],
      ['a lock (423)', statusError(423)],
      ['a rate limit (429)', statusError(429)],
      ['a server error (500)', statusError(500)],
      ['an outage (503)', statusError(503)],
      ['a gateway timeout (504)', statusError(504)],
      ['a timeout of the Mex class', statusError(408, 'MexServerStatusCodeError')],
      [
        'a rate limit of the Mex class, which the library let through as a bare error',
        statusError(429, 'MexServerStatusCodeError'),
      ],
      [
        'a request whose socket failed after it left',
        statusError(500, 'ServerStatusCodeError', 'MexIqError: Disconnected'),
      ],
      ['an outage of a Mex IQ', statusError(503, 'ServerStatusCodeError', 'MexIqError: service-unavailable')],
    ])('is a 503 that says the outcome is unknown for %s', async (_case, error) => {
      installPage({ job: { rejects: error } });

      const attempt = call(adapterOnThatPage());

      await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
      await expect(attempt).rejects.toThrow(new RegExp(`^WhatsApp Web reported ${error.status} for the `));
      await expect(attempt).rejects.toThrow(/may or may not have been applied\. Check before repeating it\.$/);
      await expect(attempt).rejects.not.toThrow(/nothing|as it was|Retry after/);
    });

    it('is a refusal when the error carries no status', async () => {
      installPage({ job: { rejects: Object.assign(new Error('refused'), { name: 'ServerStatusCodeError' }) } });

      await expect(call(adapterOnThatPage())).rejects.toBeInstanceOf(EngineRefusedError);
    });

    it('lets what is not a status from WhatsApp through', async () => {
      installPage({ job: { rejects: new Error('page closed') } });

      await expect(call(adapterOnThatPage())).rejects.toThrow('page closed');
    });
  });

  // What the library answered false for without asking WhatsApp stays the refusal, and nothing is sent.
  describe.each([
    ['the delete of a channel', (a: WhatsAppWebJsAdapter) => a.deleteChannel(CHANNEL)],
    ['the unsubscription from a channel', (a: WhatsAppWebJsAdapter) => a.unsubscribeFromChannel(CHANNEL)],
  ])('%s of a channel the page does not hold', (_name, call) => {
    it('is a refusal, and nothing is sent', async () => {
      const job = installPage({ channel: 'absent' });

      await expect(call(adapterOnThatPage())).rejects.toBeInstanceOf(EngineRefusedError);
      expect(job).not.toHaveBeenCalled();
    });
  });

  describe('the unsubscription from a channel', () => {
    it('is a refusal for a channel the account owns, and nothing is sent', async () => {
      const job = installPage({ channel: 'owner' });

      await expect(adapterOnThatPage().unsubscribeFromChannel(CHANNEL)).rejects.toBeInstanceOf(EngineRefusedError);
      expect(job).not.toHaveBeenCalled();
    });

    it('deletes the local models of the channel, as the library asks', async () => {
      const job = installPage();

      await adapterOnThatPage().unsubscribeFromChannel(CHANNEL);

      expect(job).toHaveBeenCalledWith(
        { newsletterMetadata: { membershipType: 'subscriber' } },
        { eventSurface: 3, deleteLocalModels: true },
      );
    });
  });

  // The jobs make up a status of their own for a suspended channel (a 423, which is no lock to wait out) and, each in
  // its own words, for an answer of the query that holds nothing (a 500, which is how WhatsApp can refuse an account
  // that may not make the change): no status WhatsApp sent, and no failure to retry. The mute and the unmute are no
  // exception to the delete and the unsubscription.
  describe.each([
    [
      'the delete of a channel',
      (a: WhatsAppWebJsAdapter) => a.deleteChannel(CHANNEL),
      500,
      'xwa2_newsletter_delete_v2 is null',
    ],
    [
      'the unsubscription from a channel',
      (a: WhatsAppWebJsAdapter) => a.unsubscribeFromChannel(CHANNEL),
      500,
      'unexpected-null-mex-response',
    ],
    [
      'the unsubscription from a suspended channel',
      (a: WhatsAppWebJsAdapter) => a.unsubscribeFromChannel(CHANNEL),
      423,
      'newsletter-suspended',
    ],
    [
      'the mute of a channel',
      (a: WhatsAppWebJsAdapter) => a.muteChannel(CHANNEL, true),
      500,
      'unexpected_mex_mutation_response',
    ],
    [
      'the unmute of a channel',
      (a: WhatsAppWebJsAdapter) => a.muteChannel(CHANNEL, false),
      500,
      'unexpected_mex_mutation_response',
    ],
  ])('%s when the job reports an answer it made up', (_name, call, status, message) => {
    const outcomeUnknown = async (error: Error) => {
      installPage({ job: { rejects: error } });

      const attempt = call(adapterOnThatPage());

      await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
      await expect(attempt).rejects.toThrow(/may or may not have been applied/);
    };

    it('is a refusal, not a failure to retry', async () => {
      installPage({ job: { rejects: statusError(status, 'ServerStatusCodeError', message) } });

      await expect(call(adapterOnThatPage())).rejects.toBeInstanceOf(EngineRefusedError);
    });

    // A real 500 that only mentions null is a failure like any other.
    it('is the unknown outcome for a real 500 that only mentions null', async () => {
      await outcomeUnknown(
        statusError(
          500,
          'MexServerStatusCodeError',
          'MexFatalExtensionError: Mutation: Cannot return null for non-nullable field',
        ),
      );
    });
  });

  // A page that has not the job of the write dies on it as the library's call did: never a 200 for a write not sent.
  describe.each([
    ['the delete of a channel', (a: WhatsAppWebJsAdapter) => a.deleteChannel(CHANNEL), 'WAWebNewsletterDeleteAction'],
    [
      'the unsubscription from a channel',
      (a: WhatsAppWebJsAdapter) => a.unsubscribeFromChannel(CHANNEL),
      'WAWebNewsletterUnsubscribeAction',
    ],
  ])('%s on a page without the job', (_name, call, jobModule) => {
    it.each<['throws' | 'undefined']>([['throws'], ['undefined']])(
      'rejects and sends nothing when require %s for the module',
      async unknownModule => {
        const job = installPage({ without: [jobModule], unknownModule });

        await expect(call(adapterOnThatPage())).rejects.toThrow();
        expect(job).not.toHaveBeenCalled();
      },
    );
  });

  describe('the mute and the unmute of a channel', () => {
    it.each([
      [true, 'muted'],
      [false, 'unmuted'],
    ])('send the mute state the page names for mute=%s', async (mute, state) => {
      const job = installPage();

      await adapterOnThatPage().muteChannel(CHANNEL, mute);

      expect(job).toHaveBeenCalledWith({
        newsletterJid: `jid:${CHANNEL}`,
        type: 'admin',
        muteExpirationValue: state,
      });
    });
  });

  it('sends the delete for the channel the page holds', async () => {
    const job = installPage();

    await adapterOnThatPage().deleteChannel(CHANNEL);

    expect(job).toHaveBeenCalledWith({ newsletterMetadata: { membershipType: 'subscriber' } });
  });
});
