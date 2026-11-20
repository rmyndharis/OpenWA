import { EventEmitter } from 'events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { WwebjsLifecycle } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EnginePageReloadingError, ENGINE_PAGE_RELOADING } from '../../common/errors/engine-page-reloading.error';
import { deleteGroupPictureInPage, joinInviteInPage, revokeInviteInPage } from './wwebjs-groups';
import { readStatusSetterInPage } from './wwebjs-profile';
import { pinInPage } from './wwebjs-page-writes';

/**
 * A page function that finds no job answers `'missing'`, and the adapter turns that into the 501 of a build that lacks
 * the job. A document a reload has just opened answers the same, because its modules are not defined yet, so a call that
 * a navigation lands on was told its build had no job, which a client reads as final. The navigation is stamped by the
 * time the answer comes back, so the answer is the retryable 409 then; with no navigation it stays the 501.
 */
describe('a page that finds no job while a navigation lands on the call', () => {
  const GROUP = '120363000000000001@g.us';
  const OWN = '628000000001@c.us';
  const CHAT = '628111@c.us';
  const MESSAGE_ID = 'true_628111@c.us_ABC';
  const g = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    // The lifecycle warns of every navigation it stamps.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  const wire = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'sess-missing-job', sessionDataPath: './data/sessions' });
    const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn() });
    const group = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {} };
    const chat = {
      id: { _serialized: CHAT },
      fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: MESSAGE_ID, id: 'ABC' } }]),
    };
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: OWN, user: '628000000001' } },
      pupBrowser: new EventEmitter(),
      pupPage,
      getChatById: jest.fn((id: string) => Promise.resolve(id === GROUP ? group : chat)),
    }) as unknown as EventEmitter & Record<string, unknown>;
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    lifecycle.attachPuppeteerLifecycleListeners();
    /**
     * The page function as it runs on a document that has `require` and no module yet. With `navigates` the page
     * tells of its navigation as the call is released, which is when it runs on the new document.
     */
    const onBootingDocument = (helper: unknown, navigates: boolean) =>
      pupPage.evaluate.mockImplementation((fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
        // Anything else asked of the page is the lifecycle's own read of the helpers after the navigation.
        if (fn !== helper) return Promise.resolve(false);
        if (navigates) pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
        g.window = { require: () => undefined };
        return Promise.resolve().then(() => fn(...args));
      });
    return { adapter, lifecycle, onBootingDocument };
  };
  type Wire = ReturnType<typeof wire>;

  const SITES: Array<[string, unknown, (w: Wire) => Promise<unknown>]> = [
    ['the invite revoke', revokeInviteInPage, w => w.adapter.revokeGroupInviteCode(GROUP)],
    ['the group join', joinInviteInPage, w => w.adapter.joinGroupViaInviteCode('CODE')],
    ['the group picture delete', deleteGroupPictureInPage, w => w.adapter.deleteGroupPicture(GROUP)],
    ['the own picture delete', deleteGroupPictureInPage, w => w.adapter.deleteProfilePicture()],
    ['the About probe', readStatusSetterInPage, w => w.adapter.setProfileStatus('hello')],
    ['the pin', pinInPage, w => w.adapter.pinMessage(CHAT, MESSAGE_ID, 0)],
    ['the unpin', pinInPage, w => w.adapter.unpinMessage(CHAT, MESSAGE_ID)],
  ];

  it.each(SITES)('%s answers the retryable 409 when a navigation was stamped', async (_site, helper, call) => {
    const w = wire();
    w.onBootingDocument(helper, true);

    const error = (await call(w).catch((e: unknown) => e)) as EnginePageReloadingError;

    expect(w.lifecycle.stampedNavigations()).toBe(1);
    expect(error).toBeInstanceOf(EnginePageReloadingError);
    expect(error.getResponse()).toMatchObject({ statusCode: 409, code: ENGINE_PAGE_RELOADING });
  });

  it.each(SITES)(
    '%s stays the 501 of a build without the job when no navigation was stamped',
    async (_site, helper, call) => {
      const w = wire();
      w.onBootingDocument(helper, false);

      const error = await call(w).catch((e: unknown) => e);

      expect(w.lifecycle.stampedNavigations()).toBe(0);
      expect(error).toBeInstanceOf(EngineNotSupportedError);
    },
  );
});
