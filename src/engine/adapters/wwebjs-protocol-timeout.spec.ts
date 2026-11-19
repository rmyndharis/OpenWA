import { BadRequestException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'whatsapp-web.js';
import configuration, { MAX_TIMER_MS } from '../../config/configuration';
import { validateEnv } from '../../config/env.validation';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { WwebjsLifecycle } from './wwebjs-lifecycle';
import { WwebjsGroups } from './wwebjs-groups';
import { WwebjsLabels } from './wwebjs-labels';
import { WwebjsChats } from './wwebjs-chats';
import { WwebjsContacts } from './wwebjs-contacts';
import { WwebjsChannels } from './wwebjs-channels';
import { WwebjsProfile } from './wwebjs-profile';
import { WwebjsStatus } from './wwebjs-status';
import { WwebjsMessaging } from './wwebjs-messaging';
import { type WwebjsEngineHost, withPageWrite } from './wwebjs-host';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';

/**
 * Provoked from the INSTALLED puppeteer-core rather than copied from it. The guard exists to
 * survive a message the library may reshape on a version bump, so a hand-written literal would
 * keep passing while the real string drifted out from under it — the one drift this test is
 * here to catch. Driving the real `Callback` is also what shows the label is the bare CDP
 * method name, with no `Protocol error (...)` prefix for the death pattern to match.
 */
const puppeteerProtocolTimeoutMessage = async (): Promise<string> => {
  // Load the ESM dependency in Node, outside Jest's CommonJS module loader.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { Callback } from 'puppeteer-core/internal/common/CallbackRegistry.js';
       const callback = new Callback(1, 'Runtime.callFunctionOn', 1);
       try { await callback.promise; throw new Error('protocolTimeout did not expire'); }
       catch (error) { console.log(error.message); }`,
    ],
    { cwd: join(__dirname, '../../..'), encoding: 'utf8', timeout: 10_000 },
  );
  return stdout.trim();
};

/**
 * The per-CDP-command budget handed to Puppeteer, and the one error it produces.
 *
 * Three invariants worth pinning: the value is range-checked before it leaves the config layer,
 * the option reaches the Client when set and is absent when not, and a protocol timeout is never
 * read as a dead page. The death signatures themselves are covered in whatsapp-web-js.adapter.spec.
 */
describe('whatsapp-web.js protocol timeout', () => {
  const SESSION_ID = 'sess-protocol-timeout';
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  const launchedPuppeteerOptions = async (
    protocolTimeoutMs?: number,
  ): Promise<{ protocolTimeout?: number } | undefined> => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: SESSION_ID,
      sessionDataPath: './data/sessions',
      puppeteer: { protocolTimeoutMs },
    });
    await adapter.initialize({});
    return (adapter as unknown as { client: { options: { puppeteer?: { protocolTimeout?: number } } } }).client.options
      .puppeteer;
  };

  beforeEach(() => {
    // Keep initialize() offline: 'off' skips the wa-version registry fetch in resolveWebVersionPin.
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    // Build the real wwebjs Client — that is what carries the launch options — but launch no browser.
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('hands a configured budget to the Client as puppeteer.protocolTimeout', async () => {
    expect(await launchedPuppeteerOptions(300_000)).toMatchObject({ protocolTimeout: 300_000 });
  });

  it('omits the option when unset, leaving Puppeteer its own default', async () => {
    const options = await launchedPuppeteerOptions(undefined);

    // Truly absent: `toHaveProperty` passes on a present-but-undefined key, so this is the check
    // that the option was never spread rather than spread as undefined.
    expect(options).not.toHaveProperty('protocolTimeout');
  });

  it('omits the option for a value configuration.ts would never produce', async () => {
    // The config layer is not the only writer: a plugin config (PUT /api/plugins/{id}/config) is
    // validated as an object and merged over the env blob at boot, so the sink enforces the bounds
    // too. 0 arms no timer at all; over MAX_TIMER_MS overflows Node's and fires after 1 ms.
    expect(await launchedPuppeteerOptions(0)).not.toHaveProperty('protocolTimeout');
    expect(await launchedPuppeteerOptions(-1)).not.toHaveProperty('protocolTimeout');
    expect(await launchedPuppeteerOptions(MAX_TIMER_MS + 1)).not.toHaveProperty('protocolTimeout');
    expect(await launchedPuppeteerOptions(MAX_TIMER_MS)).toMatchObject({ protocolTimeout: MAX_TIMER_MS });
  });

  describe('the bounds this knob exists to enforce', () => {
    it('rejects a non-positive or over-range value at boot instead of handing it to Puppeteer', () => {
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '0' })).toThrow(/positive integer/);
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '-1' })).toThrow(/positive integer/);
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: 'abc' })).toThrow(/positive integer/);
      // The row of nines an operator reaches for when the docs forbid 0.
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: String(MAX_TIMER_MS + 1) })).toThrow(/must not exceed/);
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '999999999999' })).toThrow(/must not exceed/);
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: String(MAX_TIMER_MS) })).not.toThrow();
      expect(() => validateEnv({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '300000' })).not.toThrow();
    });

    it('leaves the option unset for anything out of range, never falsy', () => {
      const parsed = (raw?: string): number | undefined => {
        const saved = process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS;
        if (raw === undefined) delete process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS;
        else process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS = raw;
        try {
          return (configuration() as { engine: { puppeteer: { protocolTimeoutMs?: number } } }).engine.puppeteer
            .protocolTimeoutMs;
        } finally {
          if (saved === undefined) delete process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS;
          else process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS = saved;
        }
      };

      // A blank compose forward is "unset", not 0.
      expect(parsed(undefined)).toBeUndefined();
      expect(parsed('')).toBeUndefined();
      expect(parsed('0')).toBeUndefined();
      expect(parsed('-1')).toBeUndefined();
      expect(parsed('abc')).toBeUndefined();
      expect(parsed(String(MAX_TIMER_MS + 1))).toBeUndefined();
      expect(parsed('300000')).toBe(300_000);
      expect(parsed(String(MAX_TIMER_MS))).toBe(MAX_TIMER_MS);
    });
  });

  describe('the transport classifier', () => {
    const classify = (message: string): boolean => {
      const adapter = new WhatsAppWebJsAdapter({
        sessionId: SESSION_ID,
        sessionDataPath: './data/sessions',
        puppeteer: {},
      });
      return (adapter as unknown as { isPageTransportError: (error: unknown) => boolean }).isPageTransportError(
        new Error(message),
      );
    };

    it('does not treat a protocol timeout as a dead page', async () => {
      const message = await puppeteerProtocolTimeoutMessage();

      // Guard the guard: if a bump ever drops the phrase this classifier keys on, fail here rather
      // than silently start reporting slow reads as deaths.
      expect(message).toMatch(/timed out\. Increase the 'protocolTimeout'/);
      expect(classify(message)).toBe(false);

      // The case that makes the carve-out load-bearing rather than decorative: puppeteer's own
      // `_reject` formats a rejected command as `Protocol error (label): message`, which the death
      // pattern matches. Without the carve-out this reads as a dead page.
      expect(classify(`Protocol error (Runtime.callFunctionOn): ${message}`)).toBe(false);
    });

    it('reports a death whose message also mentions a timeout', () => {
      // Why the guard matches Puppeteer's full phrase instead of a bare /timed out/: the broad
      // version swallows this, turning a reportable dead page into a silent one.
      expect(classify('Protocol error (Runtime.callFunctionOn): Session closed. Request timed out')).toBe(true);
    });
  });
});

/**
 * A timed-out command got no answer at all, so the verdict branches that read a rejection as "no such
 * group" (404), "no such invite" (404), "invalid invite" (400), "no such label" (404), "no such
 * contact" (404), "no such chat" (400) or "declined" (200 `success: false`) must not see it. It is
 * the 503 those routes document for a query that never came back, and it is not a death: the session
 * must not be torn down for a slow renderer.
 */
describe('a protocol timeout is a 503, never a not-found verdict', () => {
  const makeHost = (
    client: Record<string, jest.Mock>,
  ): { host: WwebjsEngineHost; reportIfPageTransportError: jest.Mock } => {
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => WwebjsLifecycle.prototype.isPageTransportError.call({}, error),
      reportIfPageTransportError,
      logger: createLogger('wwebjs-protocol-timeout.spec'),
      config: { sessionId: 'sess-protocol-timeout' },
    } as unknown as WwebjsEngineHost;
    return { host, reportIfPageTransportError };
  };

  const CHAT = '628@c.us';
  const chats = (host: WwebjsEngineHost): WwebjsChats => new WwebjsChats(host, {} as WwebjsMessaging);

  /** A client whose call `method` rejects: a method of the library, or the page itself for a call run in the page. */
  const rejecting = (method: string, error: Error): Record<string, jest.Mock> =>
    (method === 'pupPage.evaluate'
      ? { pupPage: { evaluate: jest.fn().mockRejectedValue(error) } }
      : { [method]: jest.fn().mockRejectedValue(error) }) as unknown as Record<string, jest.Mock>;

  const OPS: Record<string, [string, (host: WwebjsEngineHost) => Promise<unknown>]> = {
    getGroupInfo: ['getChatById', host => new WwebjsGroups(host).getGroupInfo('120363@g.us')],
    getGroupJoinInfo: ['getInviteInfo', host => new WwebjsGroups(host).getGroupJoinInfo('AbCdEf')],
    joinGroupViaInviteCode: ['pupPage.evaluate', host => new WwebjsGroups(host).joinGroupViaInviteCode('AbCdEf')],
    getChatsByLabel: ['getChatsByLabelId', host => new WwebjsLabels(host).getChatsByLabel('7')],
    getContactById: ['getContactById', host => new WwebjsContacts(host).getContactById('628@c.us')],
    upsertContact: ['saveOrEditAddressbookContact', host => new WwebjsContacts(host).upsertContact('628@c.us', 'Ada')],
    deleteContact: ['deleteAddressbookContact', host => new WwebjsContacts(host).deleteContact('628@c.us')],
    blockContact: ['getContactLidAndPhone', host => new WwebjsContacts(host).blockContact('628@c.us')],
    unblockContact: ['getContactLidAndPhone', host => new WwebjsContacts(host).unblockContact('628@c.us')],
    sendSeen: ['getChatById', host => chats(host).sendSeen(CHAT)],
    clearChatMessages: ['getChatById', host => chats(host).clearChatMessages(CHAT)],
    archiveChat: ['archiveChat', host => chats(host).archiveChat(CHAT, true)],
    muteChat: ['getChatById', host => chats(host).muteChat(CHAT, null)],
    markUnread: ['getChatById', host => chats(host).markUnread(CHAT)],
    deleteChat: ['getChatById', host => chats(host).deleteChat(CHAT)],
  };

  it.each(Object.keys(OPS))('%s answers an expired protocolTimeout with a 503 and reports no death', async op => {
    const [method, call] = OPS[op];
    const timeout = new Error(await puppeteerProtocolTimeoutMessage());
    const { host, reportIfPageTransportError } = makeHost(rejecting(method, timeout));

    await expect(call(host)).rejects.toBeInstanceOf(EngineTransportError);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // Mute and pin resolve the chat first, so the write itself is where a slow renderer runs out the budget.
  it.each([
    ['muteChat', (host: WwebjsEngineHost) => chats(host).muteChat(CHAT, Date.now() + 60_000)],
    ['unmuteChat', (host: WwebjsEngineHost) => chats(host).muteChat(CHAT, null)],
    ['pinChat', (host: WwebjsEngineHost) => chats(host).pinChat(CHAT, true)],
    ['unpinChat', (host: WwebjsEngineHost) => chats(host).pinChat(CHAT, false)],
  ] as const)('%s answers a protocolTimeout on its write with a 503 and reports no death', async (method, call) => {
    const timeout = new Error(await puppeteerProtocolTimeoutMessage());
    const { host, reportIfPageTransportError } = makeHost({
      getChatById: jest.fn().mockResolvedValue({ id: { _serialized: CHAT } }),
      [method]: jest.fn().mockRejectedValue(timeout),
    });

    await expect(call(host)).rejects.toBeInstanceOf(EngineTransportError);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // The list reads walk the whole store in one command, so they are the ones a large account
  // pushes past the budget; none has a not-found verdict, but a raw rethrow would answer 500.
  it.each([
    ['getContacts', (host: WwebjsEngineHost) => new WwebjsContacts(host).getContacts()],
    ['getChats', (host: WwebjsEngineHost) => chats(host).getChats()],
    ['getGroups', (host: WwebjsEngineHost) => new WwebjsGroups(host).getGroups()],
  ] as const)('%s answers an expired protocolTimeout with a 503 and reports no death', async (_op, call) => {
    const timeout = jest.fn().mockRejectedValue(new Error(await puppeteerProtocolTimeoutMessage()));
    const { host, reportIfPageTransportError } = makeHost({ pupPage: { evaluate: timeout } } as unknown as Record<
      string,
      jest.Mock
    >);

    await expect(call(host)).rejects.toBeInstanceOf(EngineTransportError);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // Negative twin: an ordinary page-side refusal keeps its not-found verdict.
  it.each([
    ['getGroupInfo', null],
    ['getGroupJoinInfo', GroupNotFoundError],
    ['joinGroupViaInviteCode', InvalidInviteCodeError],
    ['getChatsByLabel', LabelNotFoundError],
    ['getContactById', null],
    ['sendSeen', false],
    ['clearChatMessages', false],
    ['archiveChat', false],
    ['muteChat', BadRequestException],
    ['markUnread', false],
    ['deleteChat', false],
  ])('%s keeps its verdict for an ordinary refusal', async (op, verdict) => {
    const [method, call] = OPS[op];
    const { host } = makeHost(rejecting(method, new Error('Evaluation failed: not found')));

    if (typeof verdict === 'function') {
      await expect(call(host)).rejects.toBeInstanceOf(verdict);
    } else {
      await expect(call(host)).resolves.toBe(verdict ?? null);
    }
  });

  // A write got no answer either way, and its route documents a 503 for that: the request budget, not a raw 500.
  // Block and unblock first ask WhatsApp for the contact's privacy id and then write on the contact itself, so
  // the budget can run out in any of three steps.
  describe.each([
    ['blockContact', 'block'],
    ['unblockContact', 'unblock'],
  ] as const)('%s', (op, action) => {
    const PRIVACY_ID = '100000000000001@lid';
    const run = (host: WwebjsEngineHost): Promise<void> => new WwebjsContacts(host)[op]('628@c.us');
    const found = (): jest.Mock => jest.fn().mockResolvedValue([{ lid: PRIVACY_ID }]);
    const steps: Array<[string, (timeout: Error) => Record<string, jest.Mock>]> = [
      ['the privacy id lookup', timeout => ({ getContactLidAndPhone: jest.fn().mockRejectedValue(timeout) })],
      [
        'the contact read',
        timeout => ({ getContactLidAndPhone: found(), getContactById: jest.fn().mockRejectedValue(timeout) }),
      ],
      [
        `the ${action} itself`,
        timeout => ({
          getContactLidAndPhone: found(),
          getContactById: jest.fn().mockResolvedValue({ [action]: jest.fn().mockRejectedValue(timeout) }),
        }),
      ],
    ];

    it.each(steps)('answers a protocolTimeout in %s with a 503 and reports no death', async (_step, client) => {
      const timeout = new Error(await puppeteerProtocolTimeoutMessage());
      const { host, reportIfPageTransportError } = makeHost(client(timeout));

      const error = await run(host).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(EngineTransportError);
      expect((error as Error).message).toContain(op);
      expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });

    // Negative twins: what the closure already answered stays what it answers.
    it('keeps the 400 for a number WhatsApp holds no privacy id for', async () => {
      const { host } = makeHost({ getContactLidAndPhone: jest.fn().mockResolvedValue([{}]) });

      await expect(run(host)).rejects.toBeInstanceOf(RecipientUnreachableError);
    });

    it('keeps the 409 for a session that went away after the contact was read', async () => {
      const { host } = makeHost({
        getContactLidAndPhone: found(),
        getContactById: jest.fn().mockResolvedValue({ [action]: jest.fn() }),
      });
      // The first check is the call's own, the second the write's, after the awaits in between.
      (host.ensureReady as unknown as jest.Mock)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new EngineNotReadyError();
        });

      await expect(run(host)).rejects.toBeInstanceOf(EngineNotReadyError);
    });

    it('passes an ordinary refusal of the write through unchanged', async () => {
      const refusal = new Error('Evaluation failed: not allowed');
      const { host, reportIfPageTransportError } = makeHost({
        getContactLidAndPhone: found(),
        getContactById: jest.fn().mockResolvedValue({ [action]: jest.fn().mockRejectedValue(refusal) }),
      });

      await expect(run(host)).rejects.toBe(refusal);
      expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['upsertContact', 'saveOrEditAddressbookContact'],
    ['deleteContact', 'deleteAddressbookContact'],
  ])('%s passes an ordinary refusal through unchanged', async (op, method) => {
    const refusal = new Error('Evaluation failed: not allowed');
    const { host } = makeHost({ [method]: jest.fn().mockRejectedValue(refusal) });

    await expect(OPS[op][1](host)).rejects.toBe(refusal);
  });

  describe('withPageWrite', () => {
    const settle = (error: Error): { outcome: Promise<unknown>; reportIfPageTransportError: jest.Mock } => {
      const { host, reportIfPageTransportError } = makeHost({});
      const outcome = withPageWrite(host, 'someWrite', () => Promise.reject(error)).catch((e: unknown) => e);
      return { outcome, reportIfPageTransportError };
    };

    it('answers a protocolTimeout with a 503 that names the operation, and reports no death', async () => {
      const { outcome, reportIfPageTransportError } = settle(new Error(await puppeteerProtocolTimeoutMessage()));

      const error = await outcome;

      expect(error).toBeInstanceOf(EngineTransportError);
      expect((error as Error).message).toContain('someWrite');
      expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });

    it('still reports a dead page and answers 503', async () => {
      const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
      const { outcome, reportIfPageTransportError } = settle(dead);

      expect(await outcome).toBeInstanceOf(EngineTransportError);
      expect(reportIfPageTransportError).toHaveBeenCalledWith(dead, 'someWrite');
    });

    it('still answers the retryable 409 for a page that navigated under the call', async () => {
      const { outcome, reportIfPageTransportError } = settle(
        new Error('Execution context was destroyed, most likely because of a navigation.'),
      );

      expect(await outcome).toBeInstanceOf(EngineNotReadyError);
      expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });

    it('rethrows an ordinary failure and an answer that is already an HTTP error unchanged', async () => {
      const refusal = new Error('Evaluation failed: not allowed');
      const refused = new RecipientUnreachableError('628@c.us');

      expect((await settle(refusal).outcome) === refusal).toBe(true);
      expect((await settle(refused).outcome) === refused).toBe(true);
    });

    it('returns what the operation resolves', async () => {
      const { host } = makeHost({});

      await expect(withPageWrite(host, 'someWrite', () => Promise.resolve(42))).resolves.toBe(42);
    });
  });

  // Every other write that converges when repeated answers the same way, one row per step a write can run out of
  // budget in: the lookup it makes first, the write itself, and the read that checks it.
  describe('the writes of the other delegates', () => {
    const GROUP = '120363@g.us';
    const CHANNEL = '120363@newsletter';
    const MESSAGE = 'true_628@c.us_ABC';
    const PICTURE = { mimetype: 'image/png', data: 'eA==' };
    const failing = (error: Error): jest.Mock => jest.fn().mockRejectedValue(error);
    const resolved = (value: unknown): jest.Mock => jest.fn().mockResolvedValue(value);
    const groupChat = (over: Record<string, jest.Mock>): unknown => ({
      isGroup: true,
      id: { _serialized: GROUP },
      participants: [],
      ...over,
    });
    const labelChat = { id: { _serialized: CHAT }, getLabels: resolved([]) };
    const chatWith = (over: Record<string, jest.Mock>): unknown => ({
      isGroup: false,
      fetchMessages: resolved([{ id: { _serialized: MESSAGE, id: 'ABC' }, ...over }]),
    });
    const groups = (host: WwebjsEngineHost): WwebjsGroups => new WwebjsGroups(host);
    const labels = (host: WwebjsEngineHost): WwebjsLabels => new WwebjsLabels(host);
    const messaging = (host: WwebjsEngineHost): WwebjsMessaging => new WwebjsMessaging(host);

    // The group writes and the profile picture are sent in-page, and so is the invite code read: a page that fails is the
    // page call itself running out of budget. A page that answers 'missing' has no job to read the code with, so that
    // read is the library's own call on the chat.
    const noPageJob = (): Record<string, jest.Mock> =>
      ({ pupPage: { evaluate: resolved('missing') } }) as unknown as Record<string, jest.Mock>;
    const pageFailing = (error: Error): Record<string, jest.Mock> =>
      ({ pupPage: { evaluate: failing(error) } }) as unknown as Record<string, jest.Mock>;

    /** The client double that fails with `error` at the step under test and answers everything before it. */
    type Write = [string, (host: WwebjsEngineHost) => Promise<unknown>, (error: Error) => Record<string, jest.Mock>];
    const WRITES: Write[] = [
      ['profile name', h => new WwebjsProfile(h).setProfileName('Ada'), e => ({ setDisplayName: failing(e) })],
      [
        'profile status, the check for the setter',
        h => new WwebjsProfile(h).setProfileStatus('Busy'),
        e => ({ pupPage: { evaluate: failing(e) } }) as unknown as Record<string, jest.Mock>,
      ],
      [
        'profile status',
        h => new WwebjsProfile(h).setProfileStatus('Busy'),
        e => ({ pupPage: { evaluate: resolved(true) }, setStatus: failing(e) }) as unknown as Record<string, jest.Mock>,
      ],
      [
        'profile picture',
        h => new WwebjsProfile(h).setProfilePicture(PICTURE),
        e =>
          ({
            info: { wid: { _serialized: CHAT } },
            ...pageFailing(e),
          }) as unknown as Record<string, jest.Mock>,
      ],
      [
        'profile picture removal',
        h => new WwebjsProfile(h).deleteProfilePicture(),
        e => ({ deleteProfilePicture: failing(e) }),
      ],
      ['channel delete', h => new WwebjsChannels(h).deleteChannel(CHANNEL), e => ({ deleteChannel: failing(e) })],
      [
        'channel mute, the chat lookup',
        h => new WwebjsChannels(h).muteChannel(CHANNEL, true),
        e => ({ getChatById: failing(e) }),
      ],
      [
        'channel mute',
        h => new WwebjsChannels(h).muteChannel(CHANNEL, true),
        e => ({ getChatById: resolved({ mute: failing(e), unmute: failing(e) }) }),
      ],
      [
        'channel unsubscribe',
        h => new WwebjsChannels(h).unsubscribeFromChannel(CHANNEL),
        e => ({ unsubscribeFromChannel: failing(e) }),
      ],
      ['status delete', h => new WwebjsStatus(h).deleteStatus('status-id'), e => ({ revokeStatusMessage: failing(e) })],
      [
        'group subject',
        h => groups(h).setGroupSubject(GROUP, 'Subject'),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      [
        'group description',
        h => groups(h).setGroupDescription(GROUP, 'About'),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      [
        'group announce setting',
        h => groups(h).setGroupMessagesAdminsOnly(GROUP, true),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      [
        'group locked setting',
        h => groups(h).setGroupInfoAdminsOnly(GROUP, true),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      [
        'group member add mode',
        h => groups(h).setGroupMemberAddMode(GROUP, 'admins'),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      [
        'group picture',
        h => groups(h).setGroupPicture(GROUP, PICTURE),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      [
        'group picture removal',
        h => groups(h).deleteGroupPicture(GROUP),
        e => ({ getChatById: resolved(groupChat({})), pupPage: { evaluate: failing(e) } }),
      ],
      [
        'group invite code',
        h => groups(h).getGroupInviteCode(GROUP),
        e => ({ getChatById: resolved(groupChat({ getInviteCode: failing(e) })), ...noPageJob() }),
      ],
      [
        'group invite code, the page call',
        h => groups(h).getGroupInviteCode(GROUP),
        e => ({ getChatById: resolved(groupChat({})), ...pageFailing(e) }),
      ],
      ['group lookup of a write', h => groups(h).setGroupSubject(GROUP, 'Subject'), e => ({ getChatById: failing(e) })],
      [
        'group lookup of a write that does not converge',
        h => groups(h).leaveGroup(GROUP),
        e => ({ getChatById: failing(e) }),
      ],
      ['label add, the chat lookup', h => labels(h).addLabelToChat(CHAT, '7'), e => ({ getChatById: failing(e) })],
      [
        'label add, the labels read',
        h => labels(h).addLabelToChat(CHAT, '7'),
        e => ({ getChatById: jest.fn().mockResolvedValueOnce(labelChat).mockRejectedValue(e) }),
      ],
      [
        'label add',
        h => labels(h).addLabelToChat(CHAT, '7'),
        e => ({ getChatById: resolved(labelChat), addOrRemoveLabels: failing(e) }),
      ],
      [
        'label add, the check after the write',
        h => labels(h).addLabelToChat(CHAT, '7'),
        e => ({ getChatById: resolved(labelChat), addOrRemoveLabels: resolved(undefined), getLabels: failing(e) }),
      ],
      [
        'label removal',
        h => labels(h).removeLabelFromChat(CHAT, '7'),
        e => ({ getChatById: resolved(labelChat), addOrRemoveLabels: failing(e) }),
      ],
      [
        'message reaction',
        h => messaging(h).reactToMessage(CHAT, MESSAGE, 'x'),
        e => ({ getChatById: resolved(chatWith({ react: failing(e) })) }),
      ],
      [
        'message delete',
        h => messaging(h).deleteMessage(CHAT, MESSAGE),
        e => ({ getChatById: resolved(chatWith({ delete: failing(e) })) }),
      ],
      [
        'message delete, the chat lookup',
        h => messaging(h).deleteMessage(CHAT, MESSAGE),
        e => ({ getChatById: failing(e) }),
      ],
      [
        'message edit',
        h => messaging(h).editMessage(CHAT, MESSAGE, 'new text'),
        e => ({ getChatById: resolved(chatWith({ edit: failing(e) })) }),
      ],
      [
        'poll vote',
        h => messaging(h).votePoll(CHAT, MESSAGE, ['a']),
        e => ({ getChatById: resolved(chatWith({ vote: failing(e) })) }),
      ],
      // A build whose pin sender still takes positional arguments: the library's own call.
      [
        'message pin',
        h => messaging(h).pinMessage(CHAT, MESSAGE, 86_400),
        e => ({ getChatById: resolved(chatWith({ pin: failing(e) })), pupPage: { evaluate: resolved('legacy') } }),
      ],
      [
        'message unpin',
        h => messaging(h).unpinMessage(CHAT, MESSAGE),
        e => ({ getChatById: resolved(chatWith({ unpin: failing(e) })), pupPage: { evaluate: resolved('legacy') } }),
      ],
      // A build whose sender takes one options object: the call runs in the page.
      [
        'message pin, in the page',
        h => messaging(h).pinMessage(CHAT, MESSAGE, 86_400),
        e => ({ getChatById: resolved(chatWith({})), pupPage: { evaluate: failing(e) } }),
      ],
      [
        'message unpin, in the page',
        h => messaging(h).unpinMessage(CHAT, MESSAGE),
        e => ({ getChatById: resolved(chatWith({})), pupPage: { evaluate: failing(e) } }),
      ],
      [
        'message star',
        h => messaging(h).starMessage(CHAT, MESSAGE, true),
        e => ({ getChatById: resolved(chatWith({ star: failing(e) })) }),
      ],
    ];

    it.each(WRITES)(
      '%s answers an expired protocolTimeout with a 503 and reports no death',
      async (_name, run, client) => {
        const timeout = new Error(await puppeteerProtocolTimeoutMessage());
        const { host, reportIfPageTransportError } = makeHost(client(timeout));

        const error = await run(host).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(EngineTransportError);
        expect((error as Error).message).toContain('did not answer in time');
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
      },
    );

    it.each(WRITES)('%s still reports a dead page, once, and answers 503', async (_name, run, client) => {
      const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
      const { host, reportIfPageTransportError } = makeHost(client(dead));

      await expect(run(host)).rejects.toBeInstanceOf(EngineTransportError);
      expect(reportIfPageTransportError).toHaveBeenCalledTimes(1);
      expect(reportIfPageTransportError).toHaveBeenCalledWith(dead, expect.any(String));
    });

    it.each(WRITES)('%s passes an ordinary refusal through unchanged', async (_name, run, client) => {
      const refusal = new Error('Evaluation failed: not allowed');
      const { host, reportIfPageTransportError } = makeHost(client(refusal));

      expect((await run(host).catch((e: unknown) => e)) === refusal).toBe(true);
      expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });

    // A write that does not converge keeps the raw error: a replayable 503 there would let a retry apply it twice.
    it('leaves the leave of a group, which does not converge, with its raw timeout', async () => {
      const timeout = new Error(await puppeteerProtocolTimeoutMessage());
      const { host } = makeHost({ getChatById: resolved(groupChat({ leave: failing(timeout) })) });

      expect(
        (await groups(host)
          .leaveGroup(GROUP)
          .catch((e: unknown) => e)) === timeout,
      ).toBe(true);
    });
  });

  // A read that outran the budget read nothing: the same retryable 503, and no death. These reads sat on `withPage`,
  // which maps a navigation and a dead page but not a timeout, so each answered the raw timeout as a bare 500 while the
  // chat-label, group, contact and chat reads beside them answered 503.
  describe('the reads of the other delegates', () => {
    const GROUP = '120363@g.us';
    const CHANNEL = '120363@newsletter';
    const MESSAGE = 'true_628@c.us_ABC';
    const failing = (error: Error): jest.Mock => jest.fn().mockRejectedValue(error);
    const resolved = (value: unknown): jest.Mock => jest.fn().mockResolvedValue(value);
    const messaging = (host: WwebjsEngineHost): WwebjsMessaging => new WwebjsMessaging(host);

    let timeoutMessage = '';
    beforeAll(async () => {
      timeoutMessage = await puppeteerProtocolTimeoutMessage();
    });

    type Read = [string, (host: WwebjsEngineHost) => Promise<unknown>, (error: Error) => Record<string, jest.Mock>];
    const READS: Read[] = [
      ['label list', h => new WwebjsLabels(h).getLabels(), e => ({ getLabels: failing(e) })],
      ['one label', h => new WwebjsLabels(h).getLabelById('7'), e => ({ getLabels: failing(e) })],
      [
        'chat labels, which already answered 503',
        h => new WwebjsLabels(h).getChatLabels(CHAT),
        e => ({ getChatById: resolved({ id: { _serialized: CHAT }, getLabels: failing(e) }) }),
      ],
      ['channel list', h => new WwebjsChannels(h).getSubscribedChannels(), e => ({ getChannels: failing(e) })],
      ['one channel', h => new WwebjsChannels(h).getChannelById(CHANNEL), e => ({ getChannels: failing(e) })],
      [
        'channel messages, the channel list',
        h => new WwebjsChannels(h).getChannelMessages(CHANNEL, 5),
        e => ({ getChannels: failing(e) }),
      ],
      [
        'channel messages, the fetch',
        h => new WwebjsChannels(h).getChannelMessages(CHANNEL, 5),
        e => ({ getChannels: resolved([{ id: { _serialized: CHANNEL }, fetchMessages: failing(e) }]) }),
      ],
      [
        'group membership requests',
        h => new WwebjsGroups(h).getGroupMembershipRequests(GROUP),
        e => ({
          getChatById: resolved({ isGroup: true, id: { _serialized: GROUP }, participants: [] }),
          getGroupMembershipRequests: failing(e),
        }),
      ],
      ['contact statuses', h => new WwebjsStatus(h).getContactStatuses(), e => ({ getBroadcasts: failing(e) })],
      [
        'statuses of a contact',
        h => new WwebjsStatus(h).getContactStatus(CHAT),
        e => ({ getBroadcastById: failing(e) }),
      ],
      [
        'reactions of a message',
        h => messaging(h).getMessageReactions(CHAT, MESSAGE),
        e => ({ getChatById: failing(e) }),
      ],
      [
        'receipts of a message',
        h => messaging(h).getMessageReceipts(CHAT, MESSAGE),
        e => ({ getMessageById: failing(e) }),
      ],
      ['history of a chat', h => messaging(h).getChatHistory(CHAT, 10), e => ({ getChatById: failing(e) })],
    ];

    it.each(READS)(
      '%s answers an expired protocolTimeout with a 503 and reports no death',
      async (_name, run, client) => {
        const { host, reportIfPageTransportError } = makeHost(client(new Error(timeoutMessage)));

        const error = await run(host).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(EngineTransportError);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
      },
    );

    it.each(READS)('%s still reports a dead page, once, and answers 503', async (_name, run, client) => {
      const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
      const { host, reportIfPageTransportError } = makeHost(client(dead));

      await expect(run(host)).rejects.toBeInstanceOf(EngineTransportError);
      expect(reportIfPageTransportError).toHaveBeenCalledTimes(1);
      expect(reportIfPageTransportError).toHaveBeenCalledWith(dead, expect.any(String));
    });

    it.each(READS)('%s passes an ordinary failure through unchanged', async (_name, run, client) => {
      const failure = new Error('Evaluation failed: something else');
      const { host, reportIfPageTransportError } = makeHost(client(failure));

      expect((await run(host).catch((e: unknown) => e)) === failure).toBe(true);
      expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });

    // getNumberId is the one read that folds a failure into an answer: the phone read of a migrated number answers the
    // typed number when it fails, since the lookup before it already settled that the number exists. It keeps withPage,
    // so a timeout of that second read stays the typed number and is not turned into a 503.
    it('leaves the phone read of a migrated number answering the typed number when it times out', async () => {
      const { host } = makeHost({
        getNumberId: resolved({ _serialized: '159442138038327@lid' }),
        getContactLidAndPhone: failing(new Error(timeoutMessage)),
      });

      await expect(new WwebjsContacts(host).getNumberId('628123456789')).resolves.toBe('628123456789@c.us');
    });
  });
});
