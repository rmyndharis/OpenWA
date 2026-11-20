import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { PAGE_RELOADING_MESSAGE } from './wwebjs-lifecycle';
import { settleWriteStatus } from './wwebjs-page-writes';

// The library's own page code: the functions it ships into WhatsApp Web, which `LoadUtils` installs as `window.WWebJS`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils') as { LoadUtils: () => void };
const { GroupChat } = wwebjs as unknown as { GroupChat: new (client: unknown, data: unknown) => unknown };

/**
 * A group or profile write is sent to WhatsApp by a job of WhatsApp Web, and whatsapp-web.js reads every status the job
 * rejects with (`ServerStatusCodeError`) as `false`, which the adapter read as missing admin rights: a rate limit
 * (429, 423) or a server error (5xx), which changed nothing and may pass a moment later, was a 403. The adapter now
 * runs the job IN the page and answers by the status WhatsApp gave, 503 for those and 403 for a refusal.
 *
 * The page below behaves as build 2.3000.1054966512-alpha does, read off its scripts: `WAWebGroupModifyInfoJob` rejects
 * `ServerStatusCodeError(Number(code), text)` for the subject and description; `WAWebSetPropertyGroupAction` refuses an
 * account that cannot set a group property with an `ActionError` and, for announce and locked, RESOLVES the response
 * union (`SetPropertyResponse*`) of the request instead of rejecting a status, while member add mode goes through the
 * Mex job whose fatal error is a `MexServerStatusCodeError`; `WAWebContactProfilePicThumbBridge.sendSetPicture` rejects
 * the job's `ServerStatusCodeError`. The adapter's page functions run against it, on top of the helpers the library
 * installs as `window.WWebJS` (the picture crop and the chat lookup are replaced below, which need a canvas and the page's
 * chat store), so what is asserted is what the adapter does there.
 */
describe('a group or profile write that WhatsApp answers with a status', () => {
  const GROUP = '120363000000000001@g.us';
  const OWN = '628000000001@c.us';
  const g = globalThis as unknown as { window?: Record<string, unknown> & { WWebJS?: Record<string, unknown> } };
  const picture = { data: 'AAAA', mimetype: 'image/png' };

  afterEach(() => {
    delete g.window;
  });

  type Answer = { resolves: unknown } | { rejects: Error };
  const statusError = (status: number, name = 'ServerStatusCodeError') =>
    Object.assign(new Error(`status ${status}`), { name, status, statusCode: status });
  const actionError = () => Object.assign(new Error('Could not perform action.'), { name: 'ActionError' });
  const reply = (answer: Answer) =>
    jest.fn<Promise<unknown>, unknown[]>(() =>
      'rejects' in answer ? Promise.reject(answer.rejects) : Promise.resolve(answer.resolves),
    );
  /** The response union of WASmaxGroupsSetPropertyRPC, whose code is a string. */
  const union = (name: string, code: number) => ({
    name,
    value: {
      errorSetPropertyClientErrors: { value: { code: String(code), text: 'text' } },
      errorServerErrors: { value: { code: String(code), text: 'text' } },
    },
  });

  interface Page {
    subject?: Answer;
    description?: Answer;
    property?: Answer;
    sendSetPicture?: Answer;
    revoke?: Answer;
    admin?: boolean;
    canSetPicture?: boolean;
    /** Module names this build does not define. */
    without?: string[];
    /** What its `require` does for one: answer `undefined` (from a page.evaluate) or throw (before the page's error setup). */
    unknownModule?: 'throws' | 'undefined';
    /** Helpers of `window.WWebJS` the page lacks (the library installs them on a ready page). */
    withoutHelpers?: string[];
    /** A page the library has not installed any helper into: no `window.WWebJS` at all. */
    withoutHelperObject?: boolean;
  }

  /** WhatsApp Web as the pinned build has it, with the library's helpers installed on top of it. */
  const installPage = (page: Page = {}) => {
    const model = { groupMetadata: { descId: 'previous', canSetGroupProperty: () => page.admin !== false } };
    const jobs = {
      WAWebGroupModifyInfoJob: {
        setGroupSubject: reply(page.subject ?? { resolves: undefined }),
        setGroupDescription: reply(page.description ?? { resolves: undefined }),
        setGroupProperty: jest.fn(),
        setEphemeralGroupProperty: jest.fn(),
      },
      WAWebSetPropertyGroupAction: {
        // The page refuses an account that may not set a group property before it asks WhatsApp.
        setGroupProperty: jest.fn((chat: typeof model, ...rest: unknown[]) =>
          chat.groupMetadata.canSetGroupProperty()
            ? reply(page.property ?? { resolves: union('SetPropertyResponseSuccess', 200) })(...rest)
            : Promise.reject(actionError()),
        ),
        setGroupPropertyWithoutToast: jest.fn(),
        getActionString: jest.fn(),
      },
      WAWebContactProfilePicThumbBridge: {
        sendSetPicture: reply(page.sendSetPicture ?? { resolves: { status: 200 } }),
        requestDeletePicture: jest.fn(),
      },
      WAWebGroupInviteJob: {
        resetGroupInviteCode: reply(page.revoke ?? { resolves: { code: 'NEWCODE' } }),
        joinGroupViaInvite: jest.fn(),
      },
    };
    const modules: Record<string, unknown> = {
      WAWebWidFactory: { createWid: (id: string) => ({ _serialized: id }) },
      WARandomHex: { randomHex: () => 'abcdef01' },
      WAWebCollections: {
        ProfilePicThumb: {
          get: () => ({ canSet: () => page.canSetPicture !== false }),
          find: () => Promise.resolve({ canSet: () => page.canSetPicture !== false }),
        },
      },
      ...jobs,
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
    // The picture is cropped on a canvas, which Node has not; the request that follows is what matters here.
    g.window.WWebJS!.cropAndResizeImage = () => Promise.resolve('data:image/jpeg;base64,AAAA');
    // The chat store is the page's own: the writes read the group's model from it.
    g.window.WWebJS!.getChat = () => Promise.resolve(model);
    for (const name of page.withoutHelpers ?? []) delete g.window.WWebJS![name];
    if (page.withoutHelperObject) delete g.window.WWebJS;
    return jobs;
  };

  const adapterOnThatPage = () => {
    const evaluate = jest.fn((fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve().then(() => fn(...args)),
    );
    const client: Record<string, unknown> = {
      info: { wid: { _serialized: OWN, user: '628000000001' } },
      pupPage: { evaluate },
    };
    const chat = new GroupChat(client, {
      id: { server: 'g.us', user: '120363000000000001', _serialized: GROUP },
      name: 'group',
      isGroup: true,
      groupMetadata: { participants: [], owner: { _serialized: OWN }, creation: 1, desc: '' },
    });
    Object.assign(client, { getChatById: jest.fn().mockResolvedValue(chat) });
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  type Write = (adapter: WhatsAppWebJsAdapter) => Promise<unknown>;
  const outcomeOf = (write: Write) =>
    write(adapterOnThatPage()).then(
      () => 'done' as const,
      (error: unknown) => error,
    );
  /** The page calls the adapter made: the group lookup is the client's own, so these are the write itself. */
  const pageCallsOf = (adapter: WhatsAppWebJsAdapter) =>
    (adapter as unknown as { client: { pupPage: { evaluate: jest.Mock } } }).client.pupPage.evaluate;

  /** Each write that WhatsApp answers by rejecting a status, with the page setting that makes it do so. */
  const REJECTING: Array<[string, (answer: Answer) => Page, Write]> = [
    ['the group subject', answer => ({ subject: answer }), a => a.setGroupSubject(GROUP, 'renamed')],
    ['the group description', answer => ({ description: answer }), a => a.setGroupDescription(GROUP, 'about')],
    ['the group picture', answer => ({ sendSetPicture: answer }), a => a.setGroupPicture(GROUP, picture)],
    ['the own profile picture', answer => ({ sendSetPicture: answer }), a => a.setProfilePicture(picture)],
    ['the invite code revoke', answer => ({ revoke: answer }), a => a.revokeGroupInviteCode(GROUP)],
    // The property writes answer the same way on an earlier layout, which rejected a status where this one resolves a union.
    [
      'the group announce setting, on an earlier layout',
      answer => ({ property: answer }),
      a => a.setGroupMessagesAdminsOnly(GROUP, true),
    ],
    [
      'the group locked setting, on an earlier layout',
      answer => ({ property: answer }),
      a => a.setGroupInfoAdminsOnly(GROUP, true),
    ],
    // Member add mode goes through the Mex job, which rejects a status on the current build too.
    ['the group member add mode', answer => ({ property: answer }), a => a.setGroupMemberAddMode(GROUP, 'admins')],
  ];

  describe.each(REJECTING)('%s', (_name, page, write) => {
    it('is done when WhatsApp accepts it', async () => {
      installPage(page({ resolves: { status: 200, code: 'NEWCODE' } }));

      await expect(outcomeOf(write)).resolves.toBe('done');
    });

    it.each([403, 404])('is a refusal when WhatsApp answers %i', async status => {
      installPage(page({ rejects: statusError(status) }));

      const outcome = await outcomeOf(write);

      expect(outcome).toBeInstanceOf(EngineRefusedError);
      expect((outcome as Error).message).toContain(String(status));
    });

    // A rate limit or a server error changed nothing, and the same request may pass a moment later.
    it.each([408, 423, 429, 500, 503])(
      'is a retryable failure, not a refusal, when WhatsApp answers %i',
      async status => {
        installPage(page({ rejects: statusError(status) }));

        const outcome = await outcomeOf(write);

        expect(outcome).toBeInstanceOf(EngineTransportError);
        expect((outcome as Error).message).toContain(`answered ${status}`);
      },
    );

    it('keeps any other failure of the job as it was', async () => {
      const failure = new TypeError('something inside the job');
      installPage(page({ rejects: failure }));

      await expect(outcomeOf(write)).resolves.toBe(failure);
    });
  });

  describe('the announce and locked settings of the pinned build, which resolve the response union', () => {
    const SETTINGS: Array<[string, Write]> = [
      ['announce', a => a.setGroupMessagesAdminsOnly(GROUP, true)],
      ['locked', a => a.setGroupInfoAdminsOnly(GROUP, true)],
    ];

    describe.each(SETTINGS)('%s', (_name, write) => {
      it('is done on the success response', async () => {
        installPage({ property: { resolves: union('SetPropertyResponseSuccess', 200) } });

        await expect(outcomeOf(write)).resolves.toBe('done');
      });

      it('is a refusal when WhatsApp refuses it, where it read as done', async () => {
        installPage({ property: { resolves: union('SetPropertyResponseClientError', 403) } });

        expect(await outcomeOf(write)).toBeInstanceOf(EngineRefusedError);
      });

      it.each([
        ['SetPropertyResponseClientError', 429],
        ['SetPropertyResponseClientError', 423],
        ['SetPropertyResponseClientError', 408],
        ['SetPropertyResponseServerError', 500],
      ])('is a retryable failure on %s %i, where it read as done', async (name, code) => {
        installPage({ property: { resolves: union(name, code) } });

        expect(await outcomeOf(write)).toBeInstanceOf(EngineTransportError);
      });

      it('is a refusal for an account that may not set group properties, where it was a bare error', async () => {
        installPage({ admin: false });

        const outcome = await outcomeOf(write);

        expect(outcome).toBeInstanceOf(EngineRefusedError);
        expect((outcome as Error).message).toContain('the page says this account may not change it, nothing was sent');
        expect((outcome as Error).message).not.toContain('WhatsApp refused it');
      });

      // What an earlier layout answers when it has nothing to say: the library read it as done.
      it('is done when the job resolves something that is no response', async () => {
        installPage({ property: { resolves: undefined } });

        await expect(outcomeOf(write)).resolves.toBe('done');
      });
    });

    it('asks for each setting with the property and value the library uses', async () => {
      const jobs = installPage();
      const adapter = adapterOnThatPage();

      await adapter.setGroupMessagesAdminsOnly(GROUP, true);
      await adapter.setGroupMessagesAdminsOnly(GROUP, false);
      await adapter.setGroupInfoAdminsOnly(GROUP, true);
      await adapter.setGroupInfoAdminsOnly(GROUP, false);
      await adapter.setGroupMemberAddMode(GROUP, 'admins');
      await adapter.setGroupMemberAddMode(GROUP, 'all');

      const asked = jobs.WAWebSetPropertyGroupAction.setGroupProperty.mock.calls.map(([, property, value]) => [
        property,
        value,
      ]);
      expect(asked).toEqual([
        ['announcement', 1],
        ['announcement', 0],
        ['restrict', 1],
        ['restrict', 0],
        ['member_add_mode', 0],
        ['member_add_mode', 1],
      ]);
    });
  });

  describe('member add mode, whose Mex job rejects a status under either error class', () => {
    const write: Write = a => a.setGroupMemberAddMode(GROUP, 'admins');

    it.each([
      ['ServerStatusCodeError', 403, EngineRefusedError],
      ['MexServerStatusCodeError', 403, EngineRefusedError],
      ['MexServerStatusCodeError', 429, EngineTransportError],
      ['MexServerStatusCodeError', 500, EngineTransportError],
    ] as const)('maps a %s of %i by its status', async (name, status, expected) => {
      installPage({ property: { rejects: statusError(status, name) } });

      expect(await outcomeOf(write)).toBeInstanceOf(expected);
    });

    it('is a refusal for an account that may not set group properties', async () => {
      installPage({ admin: false });

      const outcome = await outcomeOf(write);

      expect(outcome).toBeInstanceOf(EngineRefusedError);
      expect((outcome as Error).message).toContain('the page says this account may not change it, nothing was sent');
    });

    // Setting admins on a group whose link mode is open is two writes in the page, and the second can fail after the
    // first was applied, so this 503 does not say that nothing was changed, where the other writes do.
    it('words its 503 as possibly applied in part, where a single write says it changed nothing', async () => {
      installPage({ property: { rejects: statusError(429, 'MexServerStatusCodeError') } });
      const memberAddMode = await outcomeOf(write);
      installPage({ subject: { rejects: statusError(429) } });
      const subject = await outcomeOf(a => a.setGroupSubject(GROUP, 'renamed'));

      expect((memberAddMode as Error).message).toContain('may have been applied in part');
      expect((memberAddMode as Error).message).not.toContain('changed nothing');
      expect((subject as Error).message).toContain('changed nothing');
    });
  });

  describe('the group picture and the own profile picture', () => {
    const WRITES: Array<[string, Write]> = [
      ['the group picture', a => a.setGroupPicture(GROUP, picture)],
      ['the own profile picture', a => a.setProfilePicture(picture)],
    ];

    // The page's own copy of the picture says the account may not set it: the refusal it always was.
    it.each(WRITES)('%s is a refusal when the page says the account may not set it', async (_name, write) => {
      const jobs = installPage({ canSetPicture: false });

      const outcome = await outcomeOf(write);

      expect(outcome).toBeInstanceOf(EngineRefusedError);
      expect(jobs.WAWebContactProfilePicThumbBridge.sendSetPicture).not.toHaveBeenCalled();
      // WhatsApp was never asked, so the text must not say it refused or answered.
      expect((outcome as Error).message).toContain('the page says this account may not change it, nothing was sent');
      expect((outcome as Error).message).not.toMatch(/WhatsApp (refused|answered)/);
    });

    it.each(WRITES)('%s says WhatsApp refused it when WhatsApp did', async (_name, write) => {
      installPage({ sendSetPicture: { rejects: statusError(403) } });

      const outcome = await outcomeOf(write);

      expect(outcome).toBeInstanceOf(EngineRefusedError);
      expect((outcome as Error).message).toMatch(/WhatsApp (refused it|answered) \(?403\)?/);
      expect((outcome as Error).message).not.toContain('the page says');
    });

    it.each(WRITES)('%s is a refusal when the request resolves with no success status', async (_name, write) => {
      installPage({ sendSetPicture: { resolves: undefined } });

      expect(await outcomeOf(write)).toBeInstanceOf(EngineRefusedError);
    });

    it('sets the picture of the group, and of the account under its own id', async () => {
      const jobs = installPage();
      const adapter = adapterOnThatPage();

      await adapter.setGroupPicture(GROUP, picture);
      await adapter.setProfilePicture(picture);

      const ids = jobs.WAWebContactProfilePicThumbBridge.sendSetPicture.mock.calls.map(
        ([wid]) => (wid as { _serialized: string })._serialized,
      );
      expect(ids).toEqual([GROUP, OWN]);
    });
  });

  describe('an answer whose status cannot be read, or is not a success', () => {
    it('is a refusal when a ServerStatusCodeError carries no status, as the library read it', async () => {
      installPage({ subject: { rejects: Object.assign(new Error('no status'), { name: 'ServerStatusCodeError' }) } });

      expect(await outcomeOf(a => a.setGroupSubject(GROUP, 'renamed'))).toBeInstanceOf(EngineRefusedError);
    });

    it.each([
      [
        'a client error whose code is unreadable is a refusal',
        union('SetPropertyResponseClientError', 0),
        EngineRefusedError,
      ],
      [
        'a server error whose code is unreadable is a failure to retry',
        union('SetPropertyResponseServerError', 0),
        EngineTransportError,
      ],
    ])('%s', async (_case, response, expected) => {
      installPage({ property: { resolves: response } });

      expect(await outcomeOf(a => a.setGroupMessagesAdminsOnly(GROUP, true))).toBeInstanceOf(expected);
    });

    it.each([
      [403, EngineRefusedError],
      [500, EngineTransportError],
    ])('reads a picture request that resolves the status %i', async (status, expected) => {
      installPage({ sendSetPicture: { resolves: { status } } });

      expect(await outcomeOf(a => a.setGroupPicture(GROUP, picture))).toBeInstanceOf(expected);
    });
  });

  describe('the shared mapper of a status', () => {
    const outcome = {
      request: 'the change',
      nothing: 'changed nothing',
      refused: (status: number) => `refused ${status}`,
    };

    it.each([200, 201, 204, 299])('accepts %i', status => {
      expect(() => settleWriteStatus(status, outcome)).not.toThrow();
    });

    it.each([408, 423, 429, 500, 503, 599])('asks for a retry on %i, and says what it left', status => {
      expect(() => settleWriteStatus(status, outcome)).toThrow(EngineTransportError);
      expect(() => settleWriteStatus(status, outcome)).toThrow(
        `WhatsApp answered ${status} to the change and changed nothing.`,
      );
    });

    it.each([199, 300, 400, 401, 403, 404, 422])('refuses %i with the caller wording', status => {
      expect(() => settleWriteStatus(status, outcome)).toThrow(EngineRefusedError);
      expect(() => settleWriteStatus(status, outcome)).toThrow(`refused ${status}`);
    });
  });

  describe('the group description', () => {
    it('is sent as the options object of the job, and an empty description clears it', async () => {
      const jobs = installPage();
      const adapter = adapterOnThatPage();

      await adapter.setGroupDescription(GROUP, 'about');
      await adapter.setGroupDescription(GROUP, '');

      const sent = jobs.WAWebGroupModifyInfoJob.setGroupDescription.mock.calls.map(([options]) => options);
      expect(sent).toEqual([
        { desc: 'about', groupWid: { _serialized: GROUP }, newDescId: 'abcdef01', prevDescId: 'previous' },
        { desc: null, groupWid: { _serialized: GROUP }, newDescId: 'abcdef01', prevDescId: 'previous' },
      ]);
    });
  });

  // A page that cannot run the write answers before anything was sent, and the library's own call, which reads the same
  // modules and helpers, is not tried: a build without the job is the 501, a page that has not been re-injected with
  // whatsapp-web.js's helpers is the retryable 409 of a reload.
  describe('a page that cannot run the write', () => {
    const NOT_RUN: Array<(jobs: ReturnType<typeof installPage>) => jest.Mock> = [
      jobs => jobs.WAWebGroupModifyInfoJob.setGroupSubject,
      jobs => jobs.WAWebGroupModifyInfoJob.setGroupDescription,
      jobs => jobs.WAWebSetPropertyGroupAction.setGroupProperty,
      jobs => jobs.WAWebContactProfilePicThumbBridge.sendSetPicture,
    ];
    const expectNothingAsked = (jobs: ReturnType<typeof installPage>, adapter: WhatsAppWebJsAdapter) => {
      for (const job of NOT_RUN) expect(job(jobs)).not.toHaveBeenCalled();
      // One page call, the write itself: the library's own call would be a second.
      expect(pageCallsOf(adapter)).toHaveBeenCalledTimes(1);
    };
    /** Meta's `require` answers `undefined` for a module a page has not defined, and throws before its error setup. */
    const SHAPES = [
      ['answers undefined for', 'undefined'],
      ['throws for', 'throws'],
    ] as const;

    // [what is missing, the modules to leave out, the write, the refusal that names it]
    const NO_JOB: Array<[string, string[], string, Write]> = [
      [
        'the subject, without its job',
        ['WAWebGroupModifyInfoJob'],
        'setGroupSubject',
        a => a.setGroupSubject(GROUP, 'x'),
      ],
      [
        'the subject, without the wid factory',
        ['WAWebWidFactory'],
        'setGroupSubject',
        a => a.setGroupSubject(GROUP, 'x'),
      ],
      [
        'the description, without its job',
        ['WAWebGroupModifyInfoJob'],
        'setGroupDescription',
        a => a.setGroupDescription(GROUP, 'about'),
      ],
      [
        'the description, without the random id',
        ['WARandomHex'],
        'setGroupDescription',
        a => a.setGroupDescription(GROUP, 'about'),
      ],
      [
        'the group picture, without its job',
        ['WAWebContactProfilePicThumbBridge'],
        'setGroupPicture',
        a => a.setGroupPicture(GROUP, picture),
      ],
      [
        'the group picture, without its collection',
        ['WAWebCollections'],
        'setGroupPicture',
        a => a.setGroupPicture(GROUP, picture),
      ],
      [
        'the own profile picture, without its job',
        ['WAWebContactProfilePicThumbBridge'],
        'setProfilePicture',
        a => a.setProfilePicture(picture),
      ],
      [
        'the announce setting, without its job',
        ['WAWebSetPropertyGroupAction'],
        'setGroupMessagesAdminsOnly',
        a => a.setGroupMessagesAdminsOnly(GROUP, true),
      ],
      [
        'the locked setting, without its job',
        ['WAWebSetPropertyGroupAction'],
        'setGroupInfoAdminsOnly',
        a => a.setGroupInfoAdminsOnly(GROUP, true),
      ],
      [
        'the member add mode, without its job',
        ['WAWebSetPropertyGroupAction'],
        'setGroupMemberAddMode',
        a => a.setGroupMemberAddMode(GROUP, 'admins'),
      ],
      [
        'a property, without the wid factory the chat lookup needs',
        ['WAWebWidFactory'],
        'setGroupInfoAdminsOnly',
        a => a.setGroupInfoAdminsOnly(GROUP, true),
      ],
    ];

    describe.each(SHAPES)('on a build whose require %s a module it does not define', (_shape, unknownModule) => {
      it.each(NO_JOB)('%s answers 501 and asks nothing of WhatsApp', async (_name, without, op, write) => {
        const jobs = installPage({ without, unknownModule });
        const adapter = adapterOnThatPage();

        const outcome = await write(adapter).then(
          () => 'done' as const,
          (error: unknown) => error,
        );

        expect(outcome).toBeInstanceOf(EngineNotSupportedError);
        expect((outcome as Error).message).toContain(`${op}(no write job on this build)`);
        expectNothingAsked(jobs, adapter);
      });
    });

    // [what is missing of the page's helpers, the page, the write]
    const NO_HELPERS: Array<[string, Page, Write]> = [
      ['the description, without getChat', { withoutHelpers: ['getChat'] }, a => a.setGroupDescription(GROUP, 'about')],
      [
        'the announce setting, without getChat',
        { withoutHelpers: ['getChat'] },
        a => a.setGroupMessagesAdminsOnly(GROUP, true),
      ],
      [
        'the locked setting, without getChat',
        { withoutHelpers: ['getChat'] },
        a => a.setGroupInfoAdminsOnly(GROUP, true),
      ],
      [
        'the member add mode, without getChat',
        { withoutHelpers: ['getChat'] },
        a => a.setGroupMemberAddMode(GROUP, 'all'),
      ],
      [
        'the group picture, without the cropping helper',
        { withoutHelpers: ['cropAndResizeImage'] },
        a => a.setGroupPicture(GROUP, picture),
      ],
      [
        'the own profile picture, without the cropping helper',
        { withoutHelpers: ['cropAndResizeImage'] },
        a => a.setProfilePicture(picture),
      ],
      [
        'the subject, with no helper installed at all',
        { withoutHelperObject: true, without: ['WAWebGroupModifyInfoJob'] },
        a => a.setGroupSubject(GROUP, 'x'),
      ],
      // The helpers are told first: a page that has not been re-injected cannot be judged on its jobs.
      [
        'the description, without getChat and without its job',
        { withoutHelpers: ['getChat'], without: ['WAWebGroupModifyInfoJob'] },
        a => a.setGroupDescription(GROUP, 'about'),
      ],
      [
        'the group picture, without the cropping helper and without its job',
        { withoutHelpers: ['cropAndResizeImage'], without: ['WAWebContactProfilePicThumbBridge'] },
        a => a.setGroupPicture(GROUP, picture),
      ],
    ];

    describe.each(SHAPES)('on a page whose require %s a module it does not define', (_shape, unknownModule) => {
      it.each(NO_HELPERS)('%s answers the retryable 409 of a reload and asks nothing', async (_name, page, write) => {
        const jobs = installPage({ ...page, unknownModule });
        const adapter = adapterOnThatPage();

        const outcome = await write(adapter).then(
          () => 'done' as const,
          (error: unknown) => error,
        );

        expect(outcome).toBeInstanceOf(EngineNotReadyError);
        expect(outcome).toMatchObject({
          message: PAGE_RELOADING_MESSAGE,
          response: { code: 'ENGINE_PAGE_RELOADING', retryAfterSeconds: 5 },
        });
        expectNothingAsked(jobs, adapter);
      });
    });

    // The subject needs no helper of the library, so it still runs on a page that has none, as it did.
    it('still sends the subject on a page with no helper installed, when the job is there', async () => {
      const jobs = installPage({ withoutHelperObject: true });

      await expect(outcomeOf(a => a.setGroupSubject(GROUP, 'renamed'))).resolves.toBe('done');
      expect(jobs.WAWebGroupModifyInfoJob.setGroupSubject).toHaveBeenCalledTimes(1);
    });

    // Neither answer is read as a refusal or a retryable failure of WhatsApp: it was not asked.
    it.each([
      ['a build without the job', { without: ['WAWebGroupModifyInfoJob'] }],
      ['a page without the helpers', { withoutHelperObject: true, without: ['WAWebGroupModifyInfoJob'] }],
    ] as Array<[string, Page]>)('does not read %s as a refusal or a transport failure', async (_name, page) => {
      installPage(page);

      const outcome = await outcomeOf(a => a.setGroupSubject(GROUP, 'renamed'));

      expect(outcome).not.toBeInstanceOf(EngineRefusedError);
      expect(outcome).not.toBeInstanceOf(EngineTransportError);
    });
  });
});
