import { EventEmitter } from 'events';
import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { type WwebjsLifecycle } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

const { GroupChat } = wwebjs as unknown as { GroupChat: new (client: unknown, data: unknown) => unknown };

/**
 * The invite code of a group is read in the page from `WAWebMexFetchGroupInviteCodeJob`. On a build that does not have
 * the job the gateway runs whatsapp-web.js's own `getInviteCode`, which reads the same module without asking and dies on
 * its absence with a TypeError, so the route answered a bare 500 where the revoke answers 501. The page below is WhatsApp
 * Web as such a build has it, and the library's own `getInviteCode` runs against it, so the text of the failure is the
 * one V8 makes of the library's line. On build 2.3000.1055177075 `require` answers `undefined` for the module, as the
 * loader of every build examined does from a page.evaluate (its error guard swallows the `ModuleError`); it throws that
 * error, `Requiring unknown module "%s"`, only inside a guard or before the page's error setup has run, and a build that
 * kept the module may have dropped the job from it. An error thrown in the page reaches the adapter as puppeteer hands it
 * over: a plain Error with the page's name and message.
 */
describe('reading the invite code of a group on each WhatsApp Web layout', () => {
  const GROUP = '120363000000000001@g.us';
  const OWN = '628000000001@c.us';
  const NO_JOB = /getGroupInviteCode\(no invite code job on this build\)/;
  const g = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    // The lifecycle warns of every navigation it stamps.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  /** The modules a build defines, and what its `require` does for one it does not. */
  type Page = { modules: Record<string, unknown>; unknownModule: 'undefined' | 'throws' };
  const installPage = ({ modules, unknownModule }: Page) => {
    g.window = {
      require: (name: string) => {
        if (name in modules) return modules[name];
        // What the loader throws, as the scripts of every build examined spell it: the module is a parameter of the
        // message, not part of its text.
        if (unknownModule === 'throws') {
          throw Object.assign(new Error('Requiring unknown module "%s"'), { name: 'ModuleError' });
        }
        return undefined;
      },
    };
  };
  /** WAWebMexFetchGroupInviteCodeJob on build 2.3000.1054966512-alpha has this one export. */
  const withJob = (fetchMexGroupInviteCode: jest.Mock) => ({
    WAWebMexFetchGroupInviteCodeJob: { fetchMexGroupInviteCode },
  });
  const withoutJob: Page = { modules: {}, unknownModule: 'undefined' };

  /**
   * An adapter on a ready session whose page is `first` for the gateway's own read of the code and `second` for the
   * library's, with the lifecycle listening to the page as in production. `navigatesDuring` is the read, counted from 1,
   * that the page tells a navigation of.
   */
  const adapterOn = (first: Page, second: Page = first, navigatesDuring?: 1 | 2) => {
    const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn() });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: OWN, user: '628000000001' } },
      pupBrowser: new EventEmitter(),
      pupPage,
    }) as unknown as EventEmitter & Record<string, unknown>;
    let reads = 0;
    pupPage.evaluate.mockImplementation((fn: (id: string) => unknown, id?: string) => {
      // Anything but the two reads of the code is the lifecycle asking about the page after a navigation.
      if (id !== GROUP) return Promise.resolve(false);
      reads += 1;
      installPage(reads === 1 ? first : second);
      if (navigatesDuring === reads) pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
      return Promise.resolve()
        .then(() => fn(id))
        .catch((error: Error) => {
          throw Object.assign(new Error(error.message), { name: error.name });
        });
    });
    const chat = new GroupChat(client, {
      id: { server: 'g.us', user: '120363000000000001', _serialized: GROUP },
      name: 'group',
      isGroup: true,
      groupMetadata: { participants: [], owner: { _serialized: OWN }, creation: 1, desc: '' },
    }) as { getInviteCode: () => Promise<unknown> };
    client.getChatById = jest.fn().mockResolvedValue(chat);
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'sess-invite-layout', sessionDataPath: './data/sessions' });
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle.attachPuppeteerLifecycleListeners();
    return { adapter, chat };
  };

  it('gives the code from the job, as on the pinned build', async () => {
    const fetch = jest.fn().mockResolvedValue('PINNEDCODE');
    const { adapter } = adapterOn({ modules: withJob(fetch), unknownModule: 'throws' });

    await expect(adapter.getGroupInviteCode(GROUP)).resolves.toBe('PINNEDCODE');
    expect(fetch).toHaveBeenCalledWith(GROUP);
  });

  it.each<[string, Page]>([
    ['answers undefined for the module, as build 2.3000.1055177075 does', withoutJob],
    ['throws for the module, which the build does not define', { modules: {}, unknownModule: 'throws' }],
    [
      'finds the module without the job in it',
      { modules: { WAWebMexFetchGroupInviteCodeJob: {} }, unknownModule: 'throws' },
    ],
  ])('answers 501 on a build whose require %s', async (_layout, page) => {
    const attempt = adapterOn(page).adapter.getGroupInviteCode(GROUP);

    await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
    await expect(attempt).rejects.toThrow(NO_JOB);
  });

  it.each([
    "Cannot read properties of undefined (reading 'queryGroupInviteCode')",
    'window.Store.GroupInvite.queryGroupInviteCode is not a function',
  ])('answers 501 when an earlier library fails with: %s', async message => {
    const { adapter, chat } = adapterOn(withoutJob);
    chat.getInviteCode = () => Promise.reject(Object.assign(new Error(message), { name: 'TypeError' }));

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  // Puppeteer hands a primitive thrown in the page over as it is.
  it('reads the text of a thrown string the same way', async () => {
    const { adapter, chat } = adapterOn(withoutJob);
    chat.getInviteCode = jest
      .fn()
      .mockRejectedValue("Cannot read properties of undefined (reading 'fetchMexGroupInviteCode')");

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  it('keeps the library call: its code is the answer when the page has the job by then', async () => {
    const fetch = jest.fn().mockResolvedValue({ code: 'LIBRARYCODE' });
    const { adapter } = adapterOn(withoutJob, { modules: withJob(fetch), unknownModule: 'undefined' });

    await expect(adapter.getGroupInviteCode(GROUP)).resolves.toBe('LIBRARYCODE');
    expect(fetch).toHaveBeenCalledWith(GROUP);
  });

  it('leaves the failure of the job itself as it was, since the job is there', async () => {
    const failure = new Error('[MEX][GROUP] group invite code is null');
    const job = withJob(jest.fn().mockRejectedValue(failure));
    const attempt = adapterOn(withoutJob, { modules: job, unknownModule: 'undefined' }).adapter.getGroupInviteCode(
      GROUP,
    );

    await expect(attempt).rejects.not.toBeInstanceOf(EngineNotSupportedError);
    await expect(attempt).rejects.toThrow(failure.message);
  });

  it.each([
    "Cannot read properties of undefined (reading 'somethingElse')",
    'window.require(...).somethingElse is not a function',
    // The loader's other texts are about a module that exists and cannot run, which is no missing job.
    'Requiring module "%s" which threw an exception',
    'Requiring module "%s" with unresolved dependencies: %s',
  ])('leaves a failure about something else as it was: %s', async message => {
    const { adapter, chat } = adapterOn(withoutJob);
    chat.getInviteCode = () => Promise.reject(Object.assign(new Error(message), { name: 'TypeError' }));
    const attempt = adapter.getGroupInviteCode(GROUP);

    await expect(attempt).rejects.not.toBeInstanceOf(EngineNotSupportedError);
    await expect(attempt).rejects.toThrow(message);
  });

  // A page that reloads is a build without the job for as long as it takes to boot, which is no answer to keep.
  it.each<[string, 1 | 2]>([
    ['the library read', 2],
    ["the gateway's own read", 1],
  ])('answers the retryable 409, not 501, when the page navigated during %s', async (_read, navigatesDuring) => {
    const { adapter } = adapterOn(withoutJob, withoutJob, navigatesDuring);

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
