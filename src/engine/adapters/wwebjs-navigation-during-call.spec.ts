import { EventEmitter } from 'events';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { type WwebjsEngineHost, withPage, withPageWrite } from './wwebjs-host';
import {
  CAPTURED_PAGE_ERROR_PREFIX,
  PAGE_RELOADING_MESSAGE,
  WwebjsLifecycle,
  isNavigationError,
} from './wwebjs-lifecycle';
import {
  deleteGroupPictureInPage,
  readInviteInfoInPage,
  readInviteSenderInPage,
  revokeInviteInPage,
} from './wwebjs-groups';
import { readLeanContacts } from './wwebjs-contacts';
import { readChatModels } from './wwebjs-chats';
import { readLabelChatIds, readLocalChatLabels } from './wwebjs-labels';
import { readStatusSetterInPage } from './wwebjs-profile';
import { runWriteInPage } from './wwebjs-page-writes';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';
import { createLogger } from '../../common/services/logger.service';

/**
 * Chrome clears the old page context before Puppeteer tells the adapter that the page navigated, and a call made in
 * between is held until the new context exists, which comes after that event: it runs on a document WhatsApp Web has
 * not booted, with the navigation already stamped when it fails. The page functions that start from `window.require`
 * fail with a text the classifier reads as a reload. The ones that start from `window.WWebJS`, and the library's own
 * page functions, fail with `Cannot read properties of undefined`, the text of any ordinary page error, and answered a
 * bare 500, or a 404 where a catch folds a failed lookup into "not found", where a reload answers the retryable 409.
 * A call that was cut by a navigation stamped after it began is read as that reload, whatever its text, for the reads
 * and the writes that converge when repeated, and for the group lookup in front of a write, which is a read that
 * applied nothing. A send and the other writes whose repeat could duplicate keep their answer.
 */
describe('a call that a page navigation lands on', () => {
  const GROUP = '120363000000000001@g.us';
  const OWN = '628000000001@c.us';
  const g = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    // The lifecycle warns of every navigation it stamps.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  type PageFunction = (...args: never[]) => unknown;

  /** The page function as it runs on the new document: `window` has neither `require` nor `WWebJS` yet. */
  const onUnbootedDocument = (fn: PageFunction, arg?: unknown): Promise<unknown> => {
    g.window = {};
    return Promise.resolve().then(() => (fn as (arg?: unknown) => unknown)(arg));
  };

  /**
   * An adapter on a ready session, with the lifecycle listening to the page the way it does in production, and the two
   * ways a call dies there: `fail` for a library page function, `runOnPage` for one of the adapter's own. With
   * `navigates` the page tells of its navigation as the held call is released, which is when it runs on the new document.
   */
  const wire = (navigates: boolean) => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'sess-nav-call', sessionDataPath: './data/sessions' });
    const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn() });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: OWN, user: '628000000001' } },
      pupBrowser: new EventEmitter(),
      pupPage,
    }) as unknown as EventEmitter & Record<string, unknown>;
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    lifecycle.attachPuppeteerLifecycleListeners();
    const navigate = (): void => {
      if (navigates) pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
    };
    return {
      adapter,
      client,
      pupPage,
      lifecycle,
      fail: (property: string) =>
        jest.fn((): Promise<never> => {
          navigate();
          return Promise.reject(new TypeError(`Cannot read properties of undefined (reading '${property}')`));
        }),
      runOnPage: (helper: PageFunction) =>
        pupPage.evaluate.mockImplementation((fn: PageFunction, arg?: unknown) => {
          // Anything else asked of the page is the lifecycle's own read of the helpers after the navigation.
          if (fn !== helper) return Promise.resolve(false);
          navigate();
          return onUnbootedDocument(fn, arg);
        }),
    };
  };
  type Wire = ReturnType<typeof wire>;

  const group = (extra: Record<string, unknown> = {}) => ({
    id: { _serialized: GROUP },
    isGroup: true,
    participants: [],
    groupMetadata: {},
    ...extra,
  });
  const invariant = () => new Error('Invariant Violation: a group the page cannot refresh');

  type Before = { value: unknown } | { error: new (...args: never[]) => Error };
  type Row = [name: string, call: (w: Wire) => Promise<unknown>, before: Before];

  // What each route answered for the same failure with no navigation stamped: the answer the rows below must keep.
  const reloads: Before = { error: EngineNotReadyError };
  const TYPE_ERROR: Before = { error: TypeError };

  /** The routes through the wrappers that read a navigation during the call as the reload, with the answer they gave. */
  const ROUTES: Row[] = [
    // The library's own page functions, per wrapper.
    [
      'getBlockedContacts (withPage)',
      w => {
        w.client.getBlockedContacts = w.fail('getBlockedContacts');
        return w.adapter.getBlockedContacts();
      },
      TYPE_ERROR,
    ],
    [
      'getLabels (withPageWrite)',
      w => {
        w.client.getLabels = w.fail('getLabels');
        return w.adapter.getLabels();
      },
      TYPE_ERROR,
    ],
    [
      'deleteContact (withPageWrite, a write that converges)',
      w => {
        w.client.deleteAddressbookContact = w.fail('deleteAddressbookContact');
        return w.adapter.deleteContact('628111@c.us');
      },
      TYPE_ERROR,
    ],
    [
      'muteChat (chatWrite)',
      w => {
        w.client.getChatById = jest.fn().mockResolvedValue({});
        w.client.unmuteChat = w.fail('unmuteChat');
        return w.adapter.muteChat('628111@c.us', null);
      },
      TYPE_ERROR,
    ],
    [
      'the chat lookup of muteChat (rethrowTransportFailure)',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.muteChat('628111@c.us', null);
      },
      { error: BadRequestException },
    ],
    [
      'sendSeen (rethrowTransportFailure)',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.sendSeen('628111@c.us');
      },
      { value: false },
    ],
    [
      'clearChatMessages (rethrowTransportFailure)',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.clearChatMessages('628111@c.us');
      },
      { value: false },
    ],
    [
      'archiveChat (rethrowTransportFailure)',
      w => {
        w.client.archiveChat = w.fail('archiveChat');
        return w.adapter.archiveChat('628111@c.us', true);
      },
      { value: false },
    ],
    [
      'markUnread (rethrowTransportFailure)',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.markUnread('628111@c.us');
      },
      { value: false },
    ],
    [
      'deleteChat (rethrowTransportFailure)',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.deleteChat('628111@c.us');
      },
      { value: false },
    ],
    [
      'getContactById (a failed lookup is not "no such contact")',
      w => {
        w.client.getContactById = w.fail('getContact');
        return w.adapter.getContactById('628111@c.us');
      },
      { value: null },
    ],
    [
      'getProfilePicture (a failed lookup is not "no avatar")',
      w => {
        w.client.getProfilePicUrl = w.fail('getChat');
        return w.adapter.getProfilePicture('628111@lid');
      },
      { error: EngineTransportError },
    ],
    [
      'getChatsByLabel (a failed lookup is not "no such label")',
      w => {
        w.client.getChatsByLabelId = w.fail('getModelsArray');
        return w.adapter.getChatsByLabel('7');
      },
      { error: LabelNotFoundError },
    ],
    [
      'getGroupInfo (a failed lookup is not "no such group")',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.getGroupInfo(GROUP);
      },
      { value: null },
    ],
    [
      'getGroupJoinInfo (a failed preview is not "no such invite")',
      w => {
        // The preview is the adapter's own page function, which fails on a page that holds no job as the library's did.
        const failing = w.fail('queryGroupInvite');
        w.pupPage.evaluate.mockImplementation((fn: PageFunction) =>
          fn === readInviteInfoInPage ? failing() : Promise.resolve(false),
        );
        return w.adapter.getGroupJoinInfo('code');
      },
      { error: GroupNotFoundError },
    ],
    [
      'addParticipants, the group lookup in front of the write (a read, so it is the reload too)',
      w => {
        w.client.getChatById = w.fail('getChat');
        return w.adapter.addParticipants(GROUP, ['628111@c.us']);
      },
      TYPE_ERROR,
    ],
    // The page functions the adapter ships, run on the document as it is while WhatsApp Web boots. The ones that start
    // from `window.require` fail with text the classifier already reads, so they answer the reload either way.
    [
      'readChatModels, the whole list',
      w => {
        w.runOnPage(readChatModels);
        return w.adapter.getChats();
      },
      reloads,
    ],
    [
      'readChatModels, the chats of given ids',
      w => {
        w.client.getChatById = jest.fn().mockRejectedValue(invariant());
        w.runOnPage(readChatModels);
        return w.adapter.getGroupInfo(GROUP);
      },
      { value: null },
    ],
    [
      'readLeanContacts',
      w => {
        w.runOnPage(readLeanContacts);
        return w.adapter.getContacts();
      },
      reloads,
    ],
    [
      'readLabelChatIds',
      w => {
        w.client.getChatsByLabelId = jest.fn().mockRejectedValue(invariant());
        w.runOnPage(readLabelChatIds);
        return w.adapter.getChatsByLabel('7');
      },
      reloads,
    ],
    [
      'readLocalChatLabels',
      w => {
        w.client.getChatById = jest.fn().mockResolvedValue(group({ getLabels: () => Promise.reject(invariant()) }));
        w.runOnPage(readLocalChatLabels);
        return w.adapter.getChatLabels(GROUP);
      },
      TYPE_ERROR,
    ],
    [
      'deleteGroupPictureInPage',
      w => {
        w.client.getChatById = jest.fn().mockResolvedValue(group());
        w.runOnPage(deleteGroupPictureInPage);
        return w.adapter.deleteGroupPicture(GROUP);
      },
      reloads,
    ],
    [
      'readInviteInfoInPage, the preview of an invite',
      w => {
        w.runOnPage(readInviteInfoInPage);
        return w.adapter.getGroupJoinInfo('code');
      },
      reloads,
    ],
    [
      'readStatusSetterInPage',
      w => {
        w.runOnPage(readStatusSetterInPage);
        return w.adapter.setProfileStatus('available');
      },
      reloads,
    ],
    [
      'readInviteSenderInPage, the read made before an add',
      w => {
        w.client.getChatById = jest.fn().mockResolvedValue(group());
        w.runOnPage(readInviteSenderInPage);
        return w.adapter.addParticipants(GROUP, ['628111@c.us']);
      },
      reloads,
    ],
    [
      'revokeInviteInPage, which asks nothing of WhatsApp before its first require',
      w => {
        w.client.getChatById = jest.fn().mockResolvedValue(group());
        w.runOnPage(revokeInviteInPage);
        return w.adapter.revokeGroupInviteCode(GROUP);
      },
      reloads,
    ],
    ...(
      [
        ['a subject', w => w.adapter.setGroupSubject(GROUP, 'name')],
        ['a description', w => w.adapter.setGroupDescription(GROUP, 'about')],
        ['a picture', w => w.adapter.setGroupPicture(GROUP, { data: 'AAAA', mimetype: 'image/png' })],
        ['a property', w => w.adapter.setGroupMessagesAdminsOnly(GROUP, true)],
      ] as Array<[string, (w: Wire) => Promise<unknown>]>
    ).map(([kind, call]): Row => [
      `runWriteInPage, ${kind}`,
      w => {
        w.client.getChatById = jest.fn().mockResolvedValue(group());
        w.runOnPage(runWriteInPage);
        return call(w);
      },
      reloads,
    ]),
  ];

  const answers = (call: Promise<unknown>, before: Before): Promise<void> =>
    'error' in before ? expect(call).rejects.toBeInstanceOf(before.error) : expect(call).resolves.toEqual(before.value);

  it.each(ROUTES)('%s: a navigation stamped during the call answers the retryable 409', async (_name, route) => {
    const call = route(wire(true));

    await expect(call).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(call).rejects.toMatchObject({
      message: PAGE_RELOADING_MESSAGE,
      response: { code: 'ENGINE_PAGE_RELOADING', retryAfterSeconds: 5 },
    });
  });

  it.each(ROUTES)('%s: with no navigation stamped the answer is unchanged', async (_name, route, before) => {
    await answers(route(wire(false)), before);
  });

  it('runs the failing call once: nothing is retried', async () => {
    const w = wire(true);
    w.client.getLabels = w.fail('getLabels');

    await expect(w.adapter.getLabels()).rejects.toBeInstanceOf(EngineNotReadyError);

    expect(w.client.getLabels).toHaveBeenCalledTimes(1);
  });

  describe('keeps its answer when the call could duplicate', () => {
    const PRESERVED: Array<[string, (w: Wire) => Promise<unknown>, RegExp]> = [
      [
        'addParticipants (the add itself)',
        w => {
          w.client.getChatById = jest.fn().mockResolvedValue(group({ addParticipants: w.fail('addParticipants') }));
          w.pupPage.evaluate.mockResolvedValue(true);
          return w.adapter.addParticipants(GROUP, ['628111@c.us']);
        },
        /^Cannot read properties of undefined/,
      ],
      [
        'revokeGroupInviteCode (a failure after the call began)',
        w => {
          w.client.getChatById = jest.fn().mockResolvedValue(group());
          w.pupPage.evaluate.mockImplementation(w.fail('resetGroupInviteCode'));
          return w.adapter.revokeGroupInviteCode(GROUP);
        },
        /^Cannot read properties of undefined/,
      ],
      [
        'leaveGroup',
        w => {
          w.client.getChatById = jest.fn().mockResolvedValue(group({ leave: w.fail('getChat') }));
          return w.adapter.leaveGroup(GROUP);
        },
        /^Cannot read properties of undefined/,
      ],
      [
        'a text message',
        w => {
          w.client.sendMessage = w.fail('sendMessage');
          return w.adapter.sendTextMessage(GROUP, 'hello');
        },
        /^Cannot read properties of undefined/,
      ],
    ];

    it.each(PRESERVED)('%s', async (_name, route, message) => {
      const call = route(wire(true));

      await expect(call).rejects.toBeInstanceOf(TypeError);
      await expect(call).rejects.toMatchObject({ message: expect.stringMatching(message) as unknown });
    });
  });

  it('counts the navigations it stamped, and not the one of a logout', () => {
    const { pupPage, lifecycle } = wire(true);

    pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
    pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/post_logout=1' });
    pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });

    expect(lifecycle.stampedNavigations()).toBe(2);
  });
});

describe('the classification of a failure by a navigation stamped during the call', () => {
  const ordinary = new Error('Evaluation failed: TypeError: Cannot read properties of undefined (reading getChat)');
  const timeout = new Error(
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls",
  );
  const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed');

  /** A host with the dead-page reading of the lifecycle, and a navigation count the tests move. */
  const makeHost = (extra: Partial<WwebjsEngineHost> = {}) => {
    let count = 5;
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      navigationCount: () => count,
      isPageTransportError: (error: unknown) => error === dead,
      reportIfPageTransportError,
      logger: createLogger('wwebjs-navigation-during-call.spec'),
      config: {},
      ...extra,
    } as unknown as WwebjsEngineHost;
    /** A call that fails after `moves` navigations were stamped while it ran. */
    const failing =
      (error: Error, moves = 1) =>
      () => {
        count += moves;
        return Promise.reject(error);
      };
    return { host, failing, stamp: () => count++, reportIfPageTransportError };
  };

  it('reads any other failure as the reload, and reports no death', async () => {
    const { host, failing, reportIfPageTransportError } = makeHost();

    const result = withPage(host, 'getLabels', failing(ordinary));

    await expect(result).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(result).rejects.toMatchObject({
      message: PAGE_RELOADING_MESSAGE,
      response: { code: 'ENGINE_PAGE_RELOADING', retryAfterSeconds: 5 },
    });
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  it('keeps the failure of a call no navigation landed on', async () => {
    const { host, failing } = makeHost();

    await expect(withPage(host, 'getLabels', failing(ordinary, 0))).rejects.toBe(ordinary);
  });

  it('does not take a navigation stamped before the call for one that landed during it', async () => {
    const { host, failing, stamp } = makeHost();
    stamp();

    await expect(withPageWrite(host, 'getLabels', failing(ordinary, 0))).rejects.toBe(ordinary);
  });

  it('keeps a host without the count on the text alone', async () => {
    const { host, failing } = makeHost({ navigationCount: undefined });

    await expect(withPage(host, 'getLabels', failing(ordinary))).rejects.toBe(ordinary);
  });

  it('keeps an error this application built', async () => {
    const { host, failing } = makeHost();
    const missing = new NotFoundException('Message m not found in chat 1@c.us');

    await expect(withPageWrite(host, 'deleteMessage', failing(missing))).rejects.toBe(missing);
  });

  it('keeps a failure captured inside the page', async () => {
    const { host, failing } = makeHost();
    const captured = new Error(`${CAPTURED_PAGE_ERROR_PREFIX}{"message":"refused"}`);

    await expect(withPageWrite(host, 'getLabels', failing(captured))).rejects.toBe(captured);
  });

  it('keeps the 503 of a command that outran the protocol timeout', async () => {
    const { host, failing, reportIfPageTransportError } = makeHost();

    const result = withPageWrite(host, 'getLabels', failing(timeout));

    await expect(result).rejects.toBeInstanceOf(EngineTransportError);
    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining('did not answer in time') as unknown,
    });
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  it('keeps a dead page a death', async () => {
    const { host, failing, reportIfPageTransportError } = makeHost();

    await expect(withPage(host, 'getLabels', failing(dead))).rejects.toBeInstanceOf(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(dead, 'getLabels');
  });

  it.each([
    { name: 'an ordinary error', error: ordinary, reload: true },
    { name: 'a bare string', error: 'undefined is not a function', reload: true },
    { name: 'the protocol timeout', error: timeout, reload: false },
    { name: 'an error this application built', error: new NotFoundException('x'), reload: false },
    { name: 'a failure captured inside the page', error: new Error(`${CAPTURED_PAGE_ERROR_PREFIX}{}`), reload: false },
  ])('after a navigation, $name is read as a reload: $reload', ({ error, reload }) => {
    expect(isNavigationError(error)).toBe(false);
    expect(isNavigationError(error, true)).toBe(reload);
  });
});
