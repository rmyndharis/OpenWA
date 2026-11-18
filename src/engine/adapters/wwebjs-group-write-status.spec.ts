import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { settleWriteStatus } from './wwebjs-page-writes';

// The library's own page code: the functions it ships into WhatsApp Web, which `LoadUtils` installs as `window.WWebJS`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils') as { LoadUtils: () => void };
const { GroupChat, Client } = wwebjs as unknown as {
  GroupChat: new (client: unknown, data: unknown) => unknown;
  Client: { prototype: { setProfilePicture(this: unknown, media: unknown): Promise<boolean> } };
};

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
 * the job's `ServerStatusCodeError`. The library's own page functions run against it, so what is asserted is what the
 * library does there.
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
    /** Module names this build does not define: Meta's `require` throws for them. */
    without?: string[];
    /** Helpers of `window.WWebJS` the page lacks (the library installs them on a ready page). */
    withoutHelpers?: string[];
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
        if (!(name in modules)) throw new Error(`Requiring unknown module "${name}"`);
        return modules[name];
      },
    };
    LoadUtils();
    // The picture is cropped on a canvas, which Node has not; the request that follows is what matters here.
    g.window.WWebJS!.cropAndResizeImage = () => Promise.resolve('data:image/jpeg;base64,AAAA');
    // The chat store is the page's own: the writes read the group's model from it.
    g.window.WWebJS!.getChat = () => Promise.resolve(model);
    for (const name of page.withoutHelpers ?? []) delete g.window.WWebJS![name];
    return jobs;
  };

  const adapterOnThatPage = () => {
    const evaluate = (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve().then(() => fn(...args));
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
    Object.assign(client, {
      getChatById: jest.fn().mockResolvedValue(chat),
      // The library's own client method, run on this client.
      setProfilePicture: (media: unknown) => Client.prototype.setProfilePicture.call(client, media),
    });
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
    it.each([423, 429, 500, 503])('is a retryable failure, not a refusal, when WhatsApp answers %i', async status => {
      installPage(page({ rejects: statusError(status) }));

      const outcome = await outcomeOf(write);

      expect(outcome).toBeInstanceOf(EngineTransportError);
      expect((outcome as Error).message).toContain(`answered ${status}`);
    });

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
        ['SetPropertyResponseServerError', 500],
      ])('is a retryable failure on %s %i, where it read as done', async (name, code) => {
        installPage({ property: { resolves: union(name, code) } });

        expect(await outcomeOf(write)).toBeInstanceOf(EngineTransportError);
      });

      it('is a refusal for an account that may not set group properties, where it was a bare error', async () => {
        installPage({ admin: false });

        expect(await outcomeOf(write)).toBeInstanceOf(EngineRefusedError);
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

      expect(await outcomeOf(write)).toBeInstanceOf(EngineRefusedError);
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

      expect(await outcomeOf(write)).toBeInstanceOf(EngineRefusedError);
      expect(jobs.WAWebContactProfilePicThumbBridge.sendSetPicture).not.toHaveBeenCalled();
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

    it.each([
      ['the subject', ['WAWebWidFactory'], [], (a: WhatsAppWebJsAdapter) => a.setGroupSubject(GROUP, 'renamed')],
      ['the description', [], ['getChat'], (a: WhatsAppWebJsAdapter) => a.setGroupDescription(GROUP, 'about')],
      [
        'the picture, without its collection',
        ['WAWebCollections'],
        [],
        (a: WhatsAppWebJsAdapter) => a.setGroupPicture(GROUP, picture),
      ],
      [
        'the picture, without the cropping helper',
        [],
        ['cropAndResizeImage'],
        (a: WhatsAppWebJsAdapter) => a.setGroupPicture(GROUP, picture),
      ],
      ['a property', [], ['getChat'], (a: WhatsAppWebJsAdapter) => a.setGroupInfoAdminsOnly(GROUP, true)],
    ])(
      '%s is the library call when the page lacks a module or helper it needs',
      async (_name, without, withoutHelpers, write) => {
        const jobs = installPage({ without, withoutHelpers });

        expect(await outcomeOf(write)).toBeInstanceOf(Error);
        expect(jobs.WAWebGroupModifyInfoJob.setGroupSubject).not.toHaveBeenCalled();
        expect(jobs.WAWebGroupModifyInfoJob.setGroupDescription).not.toHaveBeenCalled();
        expect(jobs.WAWebSetPropertyGroupAction.setGroupProperty).not.toHaveBeenCalled();
        expect(jobs.WAWebContactProfilePicThumbBridge.sendSetPicture).not.toHaveBeenCalled();
      },
    );
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

    it.each([423, 429, 500, 503, 599])('asks for a retry on %i, and says what it left', status => {
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

  // A page that lacks the job the helper needs answers before anything was sent, and the write is the library's own
  // call as it always was: its false is the refusal it was, and nothing is asked twice.
  describe('a build whose page lacks the job, which keeps the library call', () => {
    const MISSING: Array<[string, string[], Write]> = [
      ['the group subject', ['WAWebGroupModifyInfoJob'], a => a.setGroupSubject(GROUP, 'renamed')],
      ['the group description', ['WARandomHex'], a => a.setGroupDescription(GROUP, 'about')],
      ['the group picture', ['WAWebContactProfilePicThumbBridge'], a => a.setGroupPicture(GROUP, picture)],
      ['the own profile picture', ['WAWebContactProfilePicThumbBridge'], a => a.setProfilePicture(picture)],
      ['the announce setting', ['WAWebSetPropertyGroupAction'], a => a.setGroupMessagesAdminsOnly(GROUP, true)],
      ['the locked setting', ['WAWebSetPropertyGroupAction'], a => a.setGroupInfoAdminsOnly(GROUP, true)],
      ['the member add mode', ['WAWebSetPropertyGroupAction'], a => a.setGroupMemberAddMode(GROUP, 'admins')],
    ];

    it.each(MISSING)(
      '%s does not run the job twice and fails as the library fails there',
      async (_name, without, write) => {
        const jobs = installPage({ without });

        const outcome = await outcomeOf(write);

        // The library's own call needs the same module, so it fails where it always did, and no job was asked.
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toMatch(/Requiring unknown module/);
        expect(jobs.WAWebGroupModifyInfoJob.setGroupSubject).not.toHaveBeenCalled();
        expect(jobs.WAWebGroupModifyInfoJob.setGroupDescription).not.toHaveBeenCalled();
        expect(jobs.WAWebSetPropertyGroupAction.setGroupProperty).not.toHaveBeenCalled();
        expect(jobs.WAWebContactProfilePicThumbBridge.sendSetPicture).not.toHaveBeenCalled();
      },
    );
  });
});
