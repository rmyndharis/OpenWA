import { BadRequestException } from '@nestjs/common';
import { Callback } from 'puppeteer-core/lib/cjs/puppeteer/common/CallbackRegistry.js';
import { Client } from 'whatsapp-web.js';
import configuration, { MAX_TIMER_MS } from '../../config/configuration';
import { validateEnv } from '../../config/env.validation';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { WwebjsLifecycle } from './wwebjs-lifecycle';
import { WwebjsGroups } from './wwebjs-groups';
import { WwebjsLabels } from './wwebjs-labels';
import { WwebjsChats } from './wwebjs-chats';
import { WwebjsContacts } from './wwebjs-contacts';
import { type WwebjsMessaging } from './wwebjs-messaging';
import { type WwebjsEngineHost } from './wwebjs-host';
import { createLogger } from '../../common/services/logger.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';

/**
 * Provoked from the INSTALLED puppeteer-core rather than copied from it. The guard exists to
 * survive a message the library may reshape on a version bump, so a hand-written literal would
 * keep passing while the real string drifted out from under it — the one drift this test is
 * here to catch. Driving the real `Callback` is also what shows the label is the bare CDP
 * method name, with no `Protocol error (...)` prefix for the death pattern to match.
 */
const puppeteerProtocolTimeoutMessage = async (): Promise<string> => {
  const callback = new Callback(1, 'Runtime.callFunctionOn', 1);
  try {
    await callback.promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('puppeteer-core did not reject on an expired protocolTimeout');
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
    } as unknown as WwebjsEngineHost;
    return { host, reportIfPageTransportError };
  };

  const CHAT = '628@c.us';
  const chats = (host: WwebjsEngineHost): WwebjsChats => new WwebjsChats(host, {} as WwebjsMessaging);

  const OPS: Record<string, [string, (host: WwebjsEngineHost) => Promise<unknown>]> = {
    getGroupInfo: ['getChatById', host => new WwebjsGroups(host).getGroupInfo('120363@g.us')],
    getGroupJoinInfo: ['getInviteInfo', host => new WwebjsGroups(host).getGroupJoinInfo('AbCdEf')],
    joinGroupViaInviteCode: ['acceptInvite', host => new WwebjsGroups(host).joinGroupViaInviteCode('AbCdEf')],
    getChatsByLabel: ['getChatsByLabelId', host => new WwebjsLabels(host).getChatsByLabel('7')],
    getContactById: ['getContactById', host => new WwebjsContacts(host).getContactById('628@c.us')],
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
    const { host, reportIfPageTransportError } = makeHost({ [method]: jest.fn().mockRejectedValue(timeout) });

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
    const { host } = makeHost({ [method]: jest.fn().mockRejectedValue(new Error('Evaluation failed: not found')) });

    if (typeof verdict === 'function') {
      await expect(call(host)).rejects.toBeInstanceOf(verdict);
    } else {
      await expect(call(host)).resolves.toBe(verdict ?? null);
    }
  });
});
