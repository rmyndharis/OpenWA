import { EventEmitter } from 'events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { WwebjsLifecycle } from './wwebjs-lifecycle';
import { runChannelWriteInPage } from './wwebjs-channels';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EnginePageReloadingError, ENGINE_PAGE_RELOADING } from '../../common/errors/engine-page-reloading.error';

/**
 * The delete and the unsubscription of a channel read the channel through `window.WWebJS.getChat`, a helper
 * whatsapp-web.js installs into the page. A document that has `require` and not the helpers yet is a page that is
 * reloading, and the call died on a TypeError (a bare 500) where the group and profile writes answer the retryable 409
 * for the same page. Nothing is asked of WhatsApp before that read, so the retry is safe.
 */
describe('a channel write on a page that has require and not the whatsapp-web.js helpers', () => {
  const OWN = '628000000001@c.us';
  const CHANNEL = '120363000000000001@newsletter';
  const g = globalThis as unknown as { window?: unknown };

  const deleteNewsletterAction = jest.fn().mockResolvedValue(undefined);
  const unsubscribeFromNewsletterAction = jest.fn().mockResolvedValue(undefined);
  const updateNewsletterUserSetting = jest.fn().mockResolvedValue(undefined);
  const modules: Record<string, unknown> = {
    WAWebNewsletterDeleteAction: { deleteNewsletterAction },
    WAWebNewsletterUnsubscribeAction: { unsubscribeFromNewsletterAction },
    WAWebNewsletterUpdateUserSettingJob: { updateNewsletterUserSetting },
    WAJids: { toNewsletterJid: (id: string) => id },
    WAWebNewsletterModelUtils: { ADMIN_NOTIFICATIONS: 'admin', MUTED_STATE: 'muted', UNMUTED_STATE: 'unmuted' },
  };

  afterEach(() => {
    delete g.window;
    jest.clearAllMocks();
  });

  /** A page that has the jobs, and the helpers only when asked for. */
  const page = (helpers?: Record<string, unknown>) => {
    g.window = { require: (name: string) => modules[name], ...(helpers ? { WWebJS: helpers } : {}) };
  };

  const adapterOnThatPage = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'sess-channel-write', sessionDataPath: './data/sessions' });
    const pupPage = Object.assign(new EventEmitter(), {
      evaluate: jest.fn((fn: (...a: unknown[]) => unknown, ...a: unknown[]) => Promise.resolve().then(() => fn(...a))),
    });
    const channel = { mute: jest.fn(), unmute: jest.fn() };
    (adapter as unknown as { client: unknown }).client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: OWN, user: '628000000001' } },
      pupBrowser: new EventEmitter(),
      pupPage,
      getChatById: jest.fn().mockResolvedValue(channel),
    });
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    return { adapter, lifecycle };
  };

  const WRITES: Array<[string, (a: WhatsAppWebJsAdapter) => Promise<void>]> = [
    ['deleteChannel', a => a.deleteChannel(CHANNEL)],
    ['unsubscribeFromChannel', a => a.unsubscribeFromChannel(CHANNEL)],
  ];

  describe.each([
    ['no window.WWebJS at all', undefined],
    ['a window.WWebJS with no getChat', {}],
  ])('with %s', (_case, helpers) => {
    it.each(WRITES)('%s answers the retryable 409 of a reloading page', async (_name, call) => {
      page(helpers);
      const { adapter, lifecycle } = adapterOnThatPage();

      const error = (await call(adapter).catch((e: unknown) => e)) as EnginePageReloadingError;

      expect(lifecycle.stampedNavigations()).toBe(0);
      expect(error).toBeInstanceOf(EnginePageReloadingError);
      expect(error.getResponse()).toMatchObject({ statusCode: 409, code: ENGINE_PAGE_RELOADING });
      expect(deleteNewsletterAction).not.toHaveBeenCalled();
      expect(unsubscribeFromNewsletterAction).not.toHaveBeenCalled();
    });

    it.each(['delete', 'unsubscribe'] as const)(
      'the page function answers no-helpers before the %s job runs',
      async write => {
        page(helpers);

        await expect(runChannelWriteInPage(write, CHANNEL)).resolves.toBe('no-helpers');
      },
    );
  });

  it('still sends the delete and the unsubscription when the helpers are there', async () => {
    const channel = { newsletterMetadata: { membershipType: 'subscriber' } };
    const getChat = jest.fn().mockResolvedValue(channel);
    page({ getChat });
    const { adapter } = adapterOnThatPage();

    await adapter.deleteChannel(CHANNEL);
    await adapter.unsubscribeFromChannel(CHANNEL);

    expect(getChat.mock.calls).toEqual([
      [CHANNEL, { getAsModel: false }],
      [CHANNEL, { getAsModel: false }],
    ]);
    expect(deleteNewsletterAction).toHaveBeenCalledWith(channel);
    expect(unsubscribeFromNewsletterAction).toHaveBeenCalledWith(channel, { eventSurface: 3, deleteLocalModels: true });
  });

  it('does not ask a mute for the helpers, which it never reads', async () => {
    page();
    const { adapter } = adapterOnThatPage();

    await expect(adapter.muteChannel(CHANNEL, true)).resolves.toBeUndefined();

    expect(updateNewsletterUserSetting).toHaveBeenCalledWith({
      newsletterJid: CHANNEL,
      type: 'admin',
      muteExpirationValue: 'muted',
    });
  });
});
