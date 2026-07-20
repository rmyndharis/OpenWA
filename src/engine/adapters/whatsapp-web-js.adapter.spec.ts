import { Client, MessageMedia, WAState } from 'whatsapp-web.js';
import { EventEmitter } from 'events';
import {
  WhatsAppWebJsAdapter,
  extractLinkedParentJID,
  isHttpUrl,
  isSupportedProxyUrl,
  isExecutionContextDestroyedError,
  buildProxyLaunchConfig,
  loadRemoteMedia,
  resolveAuthTimeoutMs,
  wwebjsAckToDeliveryStatus,
  extractWwebjsCall,
} from './whatsapp-web-js.adapter';
import { getEffectiveWebVersionInfo, resolveWebVersionPin, __resetWebVersionCache } from '../wa-web-version';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode';
import { InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { ChannelMediaNotSupportedError } from '../../common/errors/channel-media-not-supported.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EditedMessage, EngineStatus, GroupEvent, IncomingCallEvent } from '../interfaces/whatsapp-engine.interface';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { fetch as undiciFetch } from 'undici';

// loadRemoteMedia now fetches bytes through the SSRF-pinned path (undici fetch), then builds the
// MessageMedia locally — so mock undici fetch, not MessageMedia.fromUrl.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

// Deterministic QR encode: the real qrcode.toDataURL is an unmocked multi-ms macrotask, so timing-based
// waits are flaky. Mocking it to resolve on the microtask queue lets the 'qr' handler settle within a
// couple of awaited flushes. No existing wwebjs spec emits 'qr', so only the QR tests are affected.
jest.mock('qrcode', () => ({
  __esModule: true,
  toDataURL: jest.fn(() => Promise.resolve('data:image/png;base64,FAKEQR')),
}));

// Spying on child_process.execFile must target the real module exports: the TypeScript __importStar
// namespace wrapper that `import * as childProcess` yields has non-configurable members, so
// jest.spyOn cannot redefine execFile on it. The adapter reads execFile live off this same object.
const childProcess = jest.requireActual<typeof import('child_process')>('child_process');

describe('wwebjsAckToDeliveryStatus (engine ack-int -> neutral DeliveryStatus boundary, #265)', () => {
  // Regression-locks the integer boundary the decoupling moved behaviour into, incl. the
  // PLAYED(4) -> 'read' collapse that the old ackToMessageStatus(4) -> READ test used to cover.
  it.each([
    [-1, 'failed'],
    [0, 'pending'],
    [1, 'sent'],
    [2, 'delivered'],
    [3, 'read'],
    [4, 'read'], // PLAYED collapses to read
    [5, 'read'], // any future/higher ack stays read, never crashes
  ])('maps wwebjs ack %i -> %s', (ack, expected) => {
    expect(wwebjsAckToDeliveryStatus(ack)).toBe(expected);
  });
});

describe('isHttpUrl (remote-media detection, case-insensitive like Baileys)', () => {
  it.each(['http://x/y.png', 'https://x/y.png', 'HTTP://X/Y.PNG', 'Https://x/y.png', 'hTtPs://x'])(
    'treats %s as a remote URL',
    url => {
      expect(isHttpUrl(url)).toBe(true);
    },
  );

  it.each(['data:image/png;base64,iVBOR', 'iVBORw0KGgoAAAANSU', 'ftp://x/y', 'httpserver-not-a-url'])(
    'treats %s as non-URL (base64 / other)',
    s => {
      expect(isHttpUrl(s)).toBe(false);
    },
  );
});

describe('isSupportedProxyUrl', () => {
  it.each(['http://proxy:8080', 'https://proxy:8443', 'socks4://proxy:1080', 'socks5://user:pass@proxy:1080'])(
    'accepts %s',
    url => {
      expect(isSupportedProxyUrl(url)).toBe(true);
    },
  );

  it.each(['not a url', 'ftp://proxy:21', 'proxy:8080', ''])('rejects %s', url => {
    expect(isSupportedProxyUrl(url)).toBe(false);
  });
});

describe('isExecutionContextDestroyedError (#708 — Puppeteer context loss during initialize)', () => {
  it('matches the bare Puppeteer error', () => {
    expect(isExecutionContextDestroyedError('Execution context was destroyed')).toBe(true);
  });

  it('matches the Runtime.callFunctionOn form (the stale-profile signature during inject)', () => {
    expect(
      isExecutionContextDestroyedError('Protocol error (Runtime.callFunctionOn): Execution context was destroyed.'),
    ).toBe(true);
  });

  it('matches the "most likely because of a navigation" variant', () => {
    expect(
      isExecutionContextDestroyedError('Execution context was destroyed, most likely because of a navigation.'),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isExecutionContextDestroyedError('EXECUTION CONTEXT WAS DESTROYED')).toBe(true);
  });

  it.each(['Failed to launch the browser process:  Code: null', 'Target closed', 'Navigation timeout exceeded', ''])(
    'does not match unrelated initialize errors (%s)',
    reason => {
      expect(isExecutionContextDestroyedError(reason)).toBe(false);
    },
  );
});

describe('buildProxyLaunchConfig (#628 — proxy credentials must not go into --proxy-server)', () => {
  it('strips credentials from an HTTP proxy and returns them as proxyAuthentication', () => {
    expect(buildProxyLaunchConfig('http://user:pass@proxy.example.com:8080')).toEqual({
      serverArg: 'http://proxy.example.com:8080',
      proxyAuthentication: { username: 'user', password: 'pass' },
      socksAuthUnsupported: false,
    });
  });

  it('URL-decodes credentials', () => {
    const cfg = buildProxyLaunchConfig('https://us%40er:p%40ss@proxy:8443');
    expect(cfg.serverArg).toBe('https://proxy:8443');
    expect(cfg.proxyAuthentication).toEqual({ username: 'us@er', password: 'p@ss' });
  });

  it('flags SOCKS credentials as unsupported (Chromium cannot authenticate SOCKS) and does NOT set proxyAuthentication', () => {
    const cfg = buildProxyLaunchConfig('socks5://user:pass@p.webshare.io:80');
    expect(cfg.serverArg).toBe('socks5://p.webshare.io:80');
    expect(cfg.proxyAuthentication).toBeUndefined();
    expect(cfg.socksAuthUnsupported).toBe(true);
  });

  it('leaves a credential-less proxy untouched', () => {
    expect(buildProxyLaunchConfig('socks5://p.webshare.io:1080')).toEqual({
      serverArg: 'socks5://p.webshare.io:1080',
      socksAuthUnsupported: false,
    });
  });
});

describe('extractLinkedParentJID (#201)', () => {
  it('returns null when no metadata is provided', () => {
    expect(extractLinkedParentJID()).toBeNull();
    expect(extractLinkedParentJID({})).toBeNull();
  });

  it('reads a string candidate directly', () => {
    expect(extractLinkedParentJID({ parentGroup: '120363000@g.us' })).toBe('120363000@g.us');
  });

  it('reads the _serialized field of a Wid candidate', () => {
    expect(extractLinkedParentJID({ parentGroup: { _serialized: '120363111@g.us' } })).toBe('120363111@g.us');
  });

  it('returns null when a Wid candidate has no _serialized', () => {
    expect(extractLinkedParentJID({ parentGroup: {} })).toBeNull();
  });

  it('prefers parentGroup, then linkedParentGroup, then linkedParent', () => {
    expect(
      extractLinkedParentJID({
        parentGroup: 'a@g.us',
        linkedParentGroup: 'b@g.us',
        linkedParent: 'c@g.us',
      }),
    ).toBe('a@g.us');

    expect(extractLinkedParentJID({ linkedParentGroup: 'b@g.us', linkedParent: 'c@g.us' })).toBe('b@g.us');
    expect(extractLinkedParentJID({ linkedParent: 'c@g.us' })).toBe('c@g.us');
  });

  it('ignores null/undefined candidates and falls through to the next', () => {
    expect(extractLinkedParentJID({ parentGroup: null, linkedParentGroup: 'b@g.us' })).toBe('b@g.us');
  });
});

describe('loadRemoteMedia — routes through the SSRF-pinned media fetch', () => {
  let fromUrlSpy: jest.SpyInstance;

  // A Response-like with a single-chunk body stream (mirrors load-remote-media.spec).
  const fakeResponse = (bytes: number[], headers: Record<string, string>) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () =>
            done
              ? Promise.resolve({ done: true, value: undefined })
              : ((done = true), Promise.resolve({ done: false, value: new Uint8Array(bytes) })),
          cancel: () => Promise.resolve(),
        };
      },
    },
  });

  beforeEach(() => {
    // Spied only to assert the vulnerable fromUrl path is NEVER taken.
    fromUrlSpy = jest.spyOn(MessageMedia, 'fromUrl');
    (undiciFetch as jest.Mock).mockReset();
  });

  afterEach(() => {
    fromUrlSpy.mockRestore();
    (undiciFetch as jest.Mock).mockReset();
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  it('builds MessageMedia from the pinned fetch bytes, never via MessageMedia.fromUrl', async () => {
    (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([104, 105], { 'content-type': 'image/png' }));

    const media = await loadRemoteMedia('https://8.8.8.8/x.png');

    expect(fromUrlSpy).not.toHaveBeenCalled(); // the unpinned node-fetch path is gone
    expect(media.mimetype).toBe('image/png');
    expect(media.data).toBe(Buffer.from([104, 105]).toString('base64'));
    expect(undiciFetch).toHaveBeenCalledWith(
      'https://8.8.8.8/x.png',
      expect.objectContaining({ redirect: 'manual' }), // pinned + redirects refused
    );
  });

  it('blocks an internal/loopback URL BEFORE any fetch (no outbound socket)', async () => {
    await expect(loadRemoteMedia('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata IP before fetching', async () => {
    await expect(loadRemoteMedia('http://169.254.169.254/latest/meta-data/x.png')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it('honors the SSRF_ALLOWED_HOSTS escape-hatch for trusted internal media stores', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'minio';
    (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([1], { 'content-type': 'image/png' }));

    const media = await loadRemoteMedia('http://minio:9000/bucket/x.png');

    expect(media.mimetype).toBe('image/png');
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebJsAdapter readiness guard (#100)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });

  it('rejects engine read ops with EngineNotReadyError when not connected', async () => {
    const adapter = newAdapter(); // status defaults to DISCONNECTED, no client

    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.getNumberId('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.resolveContactPhone('123@lid')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('carries HTTP 409 so NestJS returns "session not connected" (not 500) without a custom filter', () => {
    expect(new EngineNotReadyError().getStatus()).toBe(409);
  });
});

describe('WhatsAppWebJsAdapter.getChatHistory enrichment (parity with the live path)', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('populates location coordinates and resolves the quoted message for historical messages', async () => {
    const locMsg = {
      id: { _serialized: 'M1' },
      from: '621@c.us',
      to: 'me',
      body: '',
      type: 'location',
      timestamp: 100,
      fromMe: false,
      hasMedia: false,
      hasQuotedMsg: false,
      location: { latitude: -6.2, longitude: 106.8, description: 'Office', address: 'Jkt', url: '' },
    };
    const replyMsg = {
      id: { _serialized: 'M2' },
      from: '621@c.us',
      to: 'me',
      body: '..',
      type: 'chat',
      timestamp: 200,
      fromMe: false,
      hasMedia: false,
      hasQuotedMsg: true,
      getQuotedMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'Q1' }, body: 'earlier' }),
    };
    const chat = { fetchMessages: jest.fn().mockResolvedValue([locMsg, replyMsg]) };
    const client = { getChatById: jest.fn().mockResolvedValue(chat) };

    const out = await readyAdapter(client).getChatHistory('621@c.us', 50, false);

    expect(out[0].location).toEqual({
      latitude: -6.2,
      longitude: 106.8,
      description: 'Office',
      address: 'Jkt',
      url: undefined,
    });
    expect(out[1].quotedMessage).toEqual({ id: 'Q1', body: 'earlier' });
  });
});

describe('WhatsAppWebJsAdapter.sendPollMessage', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('sends a wwebjs Poll with mapped options and the allowMultipleAnswers flag', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'POLL1' }, timestamp: 1700000010 });
    const result = await readyAdapter({ sendMessage }).sendPollMessage('120363000@g.us', {
      name: 'Where?',
      options: ['Park', 'Beach'],
      allowMultipleAnswers: true,
    });

    expect(result).toEqual({ id: 'POLL1', timestamp: 1700000010 });
    const [to, poll] = sendMessage.mock.calls[0] as [
      string,
      {
        pollName: string;
        pollOptions: { name: string; localId: number }[];
        options: { allowMultipleAnswers: boolean };
      },
    ];
    expect(to).toBe('120363000@g.us');
    expect(poll.pollName).toBe('Where?');
    expect(poll.pollOptions).toEqual([
      { name: 'Park', localId: 0 },
      { name: 'Beach', localId: 1 },
    ]);
    expect(poll.options.allowMultipleAnswers).toBe(true);
  });

  it('defaults to single choice (allowMultipleAnswers false) when the flag is omitted', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'POLL2' }, timestamp: 1700000011 });
    await readyAdapter({ sendMessage }).sendPollMessage('120363000@g.us', { name: 'Q', options: ['A', 'B'] });

    const [, poll] = sendMessage.mock.calls[0] as [string, { options: { allowMultipleAnswers: boolean } }];
    expect(poll.options.allowMultipleAnswers).toBe(false);
  });

  it('rejects with EngineNotReadyError when the session is not connected', async () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    await expect(adapter.sendPollMessage('x@c.us', { name: 'Q', options: ['A', 'B'] })).rejects.toBeInstanceOf(
      EngineNotReadyError,
    );
  });
});

describe('WhatsAppWebJsAdapter.forwardMessage (returns the real sent id, not a synthetic fwd_ id)', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('returns the real id of the forwarded copy fetched from the destination chat', async () => {
    const forward = jest.fn().mockResolvedValue(undefined);
    const sourceChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward }]) };
    const destChat = {
      fetchMessages: jest.fn().mockResolvedValue([
        { id: { _serialized: 'OLD' }, timestamp: 100 },
        { id: { _serialized: 'REAL_FWD' }, timestamp: 200 }, // most recent fromMe = the forwarded copy
      ]),
    };
    const client = {
      getChatById: jest.fn((id: string) => Promise.resolve(id === 'dest@c.us' ? destChat : sourceChat)),
    };

    const result = await readyAdapter(client).forwardMessage('src@c.us', 'dest@c.us', 'SRC1');

    expect(forward).toHaveBeenCalledWith('dest@c.us');
    expect(result.id).toBe('REAL_FWD');
    expect(result.id).not.toMatch(/^fwd_/);
  });

  it('returns an explicit-unknown id (empty, not a real/synthetic id) when the sent copy cannot be identified', async () => {
    // Empty id leaves the forward row's waMessageId unset, so no ack can mis-match it (a source/synthetic
    // id could cross-drive another row's delivery status).
    const forward = jest.fn().mockResolvedValue(undefined);
    const sourceChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward }]) };
    const destChat = { fetchMessages: jest.fn().mockResolvedValue([]) };
    const client = {
      getChatById: jest.fn((id: string) => Promise.resolve(id === 'dest@c.us' ? destChat : sourceChat)),
    };

    const result = await readyAdapter(client).forwardMessage('src@c.us', 'dest@c.us', 'SRC1');

    expect(result.id).toBe('');
    expect(result.id).not.toMatch(/^fwd_/);
  });

  it('does not report a failure when post-forward id recovery throws (the forward already happened)', async () => {
    const forward = jest.fn().mockResolvedValue(undefined);
    const sourceChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward }]) };
    const client = {
      getChatById: jest.fn((id: string) =>
        id === 'dest@c.us' ? Promise.reject(new Error('puppeteer detached')) : Promise.resolve(sourceChat),
      ),
    };

    const result = await readyAdapter(client).forwardMessage('src@c.us', 'dest@c.us', 'SRC1');

    expect(forward).toHaveBeenCalledWith('dest@c.us');
    expect(result.id).toBe('');
  });
});

describe('WhatsAppWebJsAdapter channels (#625 — wwebjs Client has no getChannelById)', () => {
  const CHANNEL = '120363401234567890@newsletter';

  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('getChannelMessages fetches via the subscribed Channel (getChannels), not the non-existent getChannelById', async () => {
    const fetchMessages = jest
      .fn()
      .mockResolvedValue([{ id: { _serialized: 'M1' }, body: 'hello', timestamp: 1700000000, hasMedia: false }]);
    const getChannels = jest.fn().mockResolvedValue([{ id: { _serialized: CHANNEL }, name: 'News', fetchMessages }]);

    const result = await readyAdapter({ getChannels }).getChannelMessages(CHANNEL, 10);

    expect(getChannels).toHaveBeenCalled();
    expect(fetchMessages).toHaveBeenCalledWith({ limit: 10 });
    expect(result).toEqual([{ id: 'M1', body: 'hello', timestamp: 1700000000, hasMedia: false, mediaUrl: undefined }]);
  });

  it('getChannelMessages surfaces a not-found channel as ChannelNotFoundError (→ 404), not a silent []', async () => {
    const getChannels = jest
      .fn()
      .mockResolvedValue([{ id: { _serialized: 'other@newsletter' }, fetchMessages: jest.fn() }]);
    // Typed NotFoundException subclass so it maps to 404, not a plain Error → generic 500.
    await expect(readyAdapter({ getChannels }).getChannelMessages(CHANNEL)).rejects.toBeInstanceOf(
      ChannelNotFoundError,
    );
  });

  it('getChannelMessages returns [] for a channel with no messages (empty is not an error)', async () => {
    const fetchMessages = jest.fn().mockResolvedValue([]);
    const getChannels = jest.fn().mockResolvedValue([{ id: { _serialized: CHANNEL }, name: 'News', fetchMessages }]);
    await expect(readyAdapter({ getChannels }).getChannelMessages(CHANNEL)).resolves.toEqual([]);
  });

  it('getChannelById resolves from the subscribed-channel list (no getChannelById call)', async () => {
    const getChannels = jest
      .fn()
      .mockResolvedValue([
        { id: { _serialized: CHANNEL }, name: 'News', description: 'desc', subscriberCount: 5, verified: true },
      ]);
    const ch = await readyAdapter({ getChannels }).getChannelById(CHANNEL);
    expect(ch).toMatchObject({ id: CHANNEL, name: 'News', description: 'desc', subscriberCount: 5, verified: true });
  });

  it('getChannelById returns null for a channel not in the subscribed list (service maps null → 404)', async () => {
    const getChannels = jest.fn().mockResolvedValue([{ id: { _serialized: 'other@newsletter' }, name: 'Other' }]);
    await expect(readyAdapter({ getChannels }).getChannelById(CHANNEL)).resolves.toBeNull();
  });
});

describe('WhatsAppWebJsAdapter channel-JID guard (#554 — wwebjs Channel lacks Chat methods)', () => {
  const NEWSLETTER = '120363401234567890@newsletter';
  const USER = '628111@c.us';

  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  describe('sendChatState', () => {
    it('no-ops on a newsletter JID without resolving a Channel (the #554 TypeError path)', async () => {
      const getChatById = jest.fn();
      await expect(readyAdapter({ getChatById }).sendChatState(NEWSLETTER, 'typing')).resolves.toBeUndefined();
      expect(getChatById).not.toHaveBeenCalled();
    });

    it('still drives typing presence on a user JID', async () => {
      const sendStateTyping = jest.fn().mockResolvedValue(undefined);
      const getChatById = jest.fn().mockResolvedValue({ sendStateTyping });
      await readyAdapter({ getChatById }).sendChatState(USER, 'typing');
      expect(getChatById).toHaveBeenCalledWith(USER);
      expect(sendStateTyping).toHaveBeenCalled();
    });

    it('drives recording presence on a user JID', async () => {
      const sendStateRecording = jest.fn().mockResolvedValue(undefined);
      const getChatById = jest.fn().mockResolvedValue({ sendStateRecording });
      await readyAdapter({ getChatById }).sendChatState(USER, 'recording');
      expect(sendStateRecording).toHaveBeenCalled();
    });

    it('clears presence on a user JID for the paused state', async () => {
      const clearState = jest.fn().mockResolvedValue(undefined);
      const getChatById = jest.fn().mockResolvedValue({ clearState });
      await readyAdapter({ getChatById }).sendChatState(USER, 'paused');
      expect(clearState).toHaveBeenCalled();
    });
  });

  describe('markUnread', () => {
    it('returns false and skips getChatById on a newsletter JID', async () => {
      const getChatById = jest.fn();
      await expect(readyAdapter({ getChatById }).markUnread(NEWSLETTER)).resolves.toBe(false);
      expect(getChatById).not.toHaveBeenCalled();
    });

    it('marks a user chat unread (returns true)', async () => {
      const markUnread = jest.fn().mockResolvedValue(undefined);
      const getChatById = jest.fn().mockResolvedValue({ markUnread });
      await expect(readyAdapter({ getChatById }).markUnread(USER)).resolves.toBe(true);
      expect(markUnread).toHaveBeenCalled();
    });
  });

  describe('deleteChat', () => {
    it('returns false and skips getChatById on a newsletter JID (does not route to deleteChannel)', async () => {
      const getChatById = jest.fn();
      await expect(readyAdapter({ getChatById }).deleteChat(NEWSLETTER)).resolves.toBe(false);
      expect(getChatById).not.toHaveBeenCalled();
    });

    it('deletes a user chat (returns the underlying delete result)', async () => {
      const del = jest.fn().mockResolvedValue(true);
      const getChatById = jest.fn().mockResolvedValue({ delete: del });
      await expect(readyAdapter({ getChatById }).deleteChat(USER)).resolves.toBe(true);
      expect(del).toHaveBeenCalled();
    });
  });

  describe('getChatLabels', () => {
    it('returns [] on a newsletter JID instead of throwing (was an unguarded HTTP 500)', async () => {
      const getChatById = jest.fn();
      await expect(readyAdapter({ getChatById }).getChatLabels(NEWSLETTER)).resolves.toEqual([]);
      expect(getChatById).not.toHaveBeenCalled();
    });

    it('maps labels through for a user JID', async () => {
      const getLabels = jest.fn().mockResolvedValue([{ id: 1, name: 'VIP', hexColor: '#fff' }]);
      const getChatById = jest.fn().mockResolvedValue({ getLabels });
      await expect(readyAdapter({ getChatById }).getChatLabels(USER)).resolves.toEqual([
        { id: '1', name: 'VIP', hexColor: '#fff' },
      ]);
    });
  });

  describe('media sends (sendImageMessage/sendVideo/sendAudio/sendDocument/sendSticker)', () => {
    // whatsapp-web.js crashes building a channel media message: `msg.avParams is not a function`
    // (upstream wwebjs#201823). image/video/audio/document funnel through sendMediaMessage; sticker
    // has its own path but hits the same channel crash. Guarding both fail-fasts as a typed 501
    // instead of surfacing the raw TypeError as a 500 (#673).
    it('rejects sendImageMessage on a newsletter JID with ChannelMediaNotSupportedError (→ 501)', async () => {
      const sendMessage = jest.fn();
      const err = await readyAdapter({ sendMessage })
        .sendImageMessage(NEWSLETTER, { mimetype: 'image/jpeg', data: Buffer.from([1]).toString('base64') })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChannelMediaNotSupportedError);
      // Pin the user-facing contract: this must surface as 501, not regress to a 500 (the raw
      // upstream crash) or drift if the base class ever changes.
      expect((err as ChannelMediaNotSupportedError).getStatus()).toBe(501);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('rejects sendStickerMessage on a newsletter JID too (parity — sticker has its own path but same crash)', async () => {
      const sendMessage = jest.fn();
      const err = await readyAdapter({ sendMessage })
        .sendStickerMessage(NEWSLETTER, { mimetype: 'image/webp', data: Buffer.from([1]).toString('base64') })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChannelMediaNotSupportedError);
      expect((err as ChannelMediaNotSupportedError).getStatus()).toBe(501);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('still sends media on a user JID', async () => {
      const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 });
      await expect(
        readyAdapter({ sendMessage }).sendImageMessage(USER, {
          mimetype: 'image/jpeg',
          data: Buffer.from([1]).toString('base64'),
        }),
      ).resolves.toMatchObject({ id: 'M1' });
      expect(sendMessage).toHaveBeenCalledWith(USER, expect.anything(), expect.anything());
    });
  });
});

describe('WhatsAppWebJsAdapter chat labels (add/remove via read-modify-write, Business-only)', () => {
  const USER = '628111@c.us';
  const NEWSLETTER = '120363401234567890@newsletter';

  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  // whatsapp-web.js has no add-/remove-one primitive: addOrRemoveLabels(ids, chats) REPLACES the chat's
  // label set with `ids`. A client mock that reports the chat already carries label 'A'.
  const clientWith = (existing: string[], addOrRemoveLabels: jest.Mock) => ({
    getChatById: jest.fn().mockResolvedValue({
      getLabels: jest.fn().mockResolvedValue(existing.map(id => ({ id, name: id, hexColor: '#fff' }))),
    }),
    addOrRemoveLabels,
  });

  it('adds a label by writing back the union of the existing set and the new id', async () => {
    const addOrRemoveLabels = jest.fn().mockResolvedValue(undefined);
    await readyAdapter(clientWith(['A'], addOrRemoveLabels)).addLabelToChat(USER, 'B');
    expect(addOrRemoveLabels).toHaveBeenCalledWith(['A', 'B'], [USER]);
  });

  it('is idempotent when adding a label the chat already has', async () => {
    const addOrRemoveLabels = jest.fn().mockResolvedValue(undefined);
    await readyAdapter(clientWith(['A', 'B'], addOrRemoveLabels)).addLabelToChat(USER, 'B');
    expect(addOrRemoveLabels).toHaveBeenCalledWith(['A', 'B'], [USER]);
  });

  it('removes a label by writing back the set without it (keeping the rest)', async () => {
    const addOrRemoveLabels = jest.fn().mockResolvedValue(undefined);
    await readyAdapter(clientWith(['A', 'B'], addOrRemoveLabels)).removeLabelFromChat(USER, 'A');
    expect(addOrRemoveLabels).toHaveBeenCalledWith(['B'], [USER]);
  });

  it('maps the whatsapp-web.js [LT01] "Only Whatsapp business" write error to 422', async () => {
    const addOrRemoveLabels = jest
      .fn()
      .mockRejectedValue(new Error('Evaluation failed: [LT01] Only Whatsapp business'));
    await expect(readyAdapter(clientWith(['A'], addOrRemoveLabels)).addLabelToChat(USER, 'B')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('rethrows a generic write failure unchanged (does not mask it as 422)', async () => {
    const addOrRemoveLabels = jest.fn().mockRejectedValue(new Error('puppeteer detached'));
    await expect(readyAdapter(clientWith(['A'], addOrRemoveLabels)).addLabelToChat(USER, 'B')).rejects.toThrow(
      'puppeteer detached',
    );
  });

  it('rejects with 422 for a channel JID and never touches the client', async () => {
    const addOrRemoveLabels = jest.fn();
    const client = clientWith(['A'], addOrRemoveLabels);
    await expect(readyAdapter(client).addLabelToChat(NEWSLETTER, 'B')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(client.getChatById).not.toHaveBeenCalled();
    expect(addOrRemoveLabels).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebJsAdapter.forceDestroy (recover a wedged session, #351)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });
  const setClient = (adapter: WhatsAppWebJsAdapter, client: unknown): void => {
    (adapter as unknown as { client: unknown }).client = client;
  };
  const getClient = (adapter: WhatsAppWebJsAdapter): unknown => (adapter as unknown as { client: unknown }).client;

  it('SIGKILLs only its own browser process, then best-effort destroys the client', async () => {
    const kill = jest.fn();
    const destroy = jest.fn().mockResolvedValue(undefined);
    const adapter = newAdapter();
    setClient(adapter, { pupBrowser: { process: () => ({ kill }) }, destroy });

    await adapter.forceDestroy();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(getClient(adapter)).toBeNull();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('still completes when the process handle is gone and destroy() rejects (best-effort)', async () => {
    const adapter = newAdapter();
    setClient(adapter, {
      pupBrowser: { process: () => null },
      destroy: jest.fn().mockRejectedValue(new Error('wedged')),
    });

    await expect(adapter.forceDestroy()).resolves.toBeUndefined();
    expect(getClient(adapter)).toBeNull();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('records teardown intent even when startup has not assigned a client yet', async () => {
    const adapter = newAdapter();
    await expect(adapter.forceDestroy()).resolves.toBeUndefined();
    expect((adapter as unknown as { tearingDown: boolean }).tearingDown).toBe(true);
  });
});

describe('WhatsAppWebJsAdapter ready reconciliation (#251/#273)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });
  type FakeClient = EventEmitter & {
    info?: { wid?: { user?: string }; pushname?: string };
    getState: jest.Mock;
    pupPage: { evaluate: jest.Mock };
    destroy?: jest.Mock;
    logout?: jest.Mock;
    pupBrowser?: { process?: jest.Mock };
  };
  const attachFakeClient = (
    adapter: WhatsAppWebJsAdapter,
    overrides: Partial<FakeClient> = {},
  ): { client: FakeClient; onReady: jest.Mock; onStateChanged: jest.Mock } => {
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: {
        evaluate: jest.fn().mockResolvedValue(true),
      },
      ...overrides,
    }) as FakeClient;
    const onReady = jest.fn();
    const onStateChanged = jest.fn();

    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = { onReady, onStateChanged };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();

    return { client, onReady, onStateChanged };
  };
  const deferredVoid = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => undefined;
    const promise = new Promise<void>(res => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const expectNoReadyDuringTeardown = async (
    configureClient: (client: FakeClient, teardownWait: Promise<void>) => void,
    startTeardown: (adapter: WhatsAppWebJsAdapter) => Promise<void>,
  ): Promise<void> => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const teardownWait = deferredVoid();
    const { client, onReady, onStateChanged } = attachFakeClient(adapter);
    configureClient(client, teardownWait.promise);

    client.emit('authenticated');
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(jest.getTimerCount()).toBe(1);

    const teardown = startTeardown(adapter);

    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onStateChanged).toHaveBeenLastCalledWith(EngineStatus.DISCONNECTED);
    expect(jest.getTimerCount()).toBe(0);

    client.emit('ready');
    await jest.advanceTimersByTimeAsync(2100);

    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onReady).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    teardownWait.resolve();
    await teardown;

    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onReady).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks the adapter ready when authenticated runtime is connected but the ready event is missed', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter);

    client.emit('authenticated');
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);

    await jest.advanceTimersByTimeAsync(2100);

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledWith('628123', 'Tester');
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does not promote while the runtime is connected but client info is not populated yet', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter, { info: undefined });

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(2100);

    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(onReady).not.toHaveBeenCalled();

    client.emit('auth_failure', 'stop test timer');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('deduplicates the genuine ready event after reconciliation promotes the adapter', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter);

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(2100);
    client.emit('ready');

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it.each([['disconnected', EngineStatus.DISCONNECTED] as const, ['auth_failure', EngineStatus.FAILED] as const])(
    'does not promote if %s fires during an in-flight probe tick',
    async (event, expectedStatus) => {
      jest.useFakeTimers();

      const adapter = newAdapter();
      const { client, onReady } = attachFakeClient(adapter);
      client.pupPage.evaluate.mockImplementation(() => {
        client.emit(event, 'test teardown');
        return Promise.resolve(true);
      });

      client.emit('authenticated');
      await jest.advanceTimersByTimeAsync(2100);

      expect(adapter.getStatus()).toBe(expectedStatus);
      expect(onReady).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('keeps repeated authenticated events to one timer chain and ignores authenticated after ready', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter);

    client.emit('authenticated');
    expect(jest.getTimerCount()).toBe(1);
    client.emit('authenticated');
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(2100);
    client.emit('authenticated');

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(jest.getTimerCount()).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('disables ready reconciliation before disconnect awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.destroy = jest.fn().mockReturnValue(teardownWait);
      },
      adapter => adapter.disconnect(),
    );
  });

  it('disables ready reconciliation before logout awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.logout = jest.fn().mockReturnValue(teardownWait);
        client.destroy = jest.fn().mockResolvedValue(undefined);
      },
      adapter => adapter.logout(),
    );
  });

  it('disables ready reconciliation before destroy awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.destroy = jest.fn().mockReturnValue(teardownWait);
      },
      adapter => adapter.destroy(),
    );
  });

  it('disables ready reconciliation before forceDestroy awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.pupBrowser = { process: jest.fn().mockReturnValue({ kill: jest.fn() }) };
        client.destroy = jest.fn().mockReturnValue(teardownWait);
      },
      adapter => adapter.forceDestroy(),
    );
  });

  // A re-fired 'authenticated' (whatsapp-web.js can emit it again on a resume/resync before 'ready')
  // must NOT restart the 90s reconcile window, or a flapping link keeps the probe alive forever.
  it('does not reset the 90s reconcile deadline when authenticated re-fires mid-probe', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    // Runtime never reports the WWebJS global, so the probe never promotes and ticks to the deadline.
    const { client } = attachFakeClient(adapter, { pupPage: { evaluate: jest.fn().mockResolvedValue(false) } });

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(80_000);
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);

    client.emit('authenticated'); // re-fire 80s in — must not restart the window
    await jest.advanceTimersByTimeAsync(11_000); // 91s total since the FIRST authenticated

    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(jest.getTimerCount()).toBe(0); // gave up at 90s; not reset by the re-fire
  });

  // beginClientTeardown sets DISCONNECTED before the awaited destroy/logout; an 'authenticated' event
  // arriving in that window must not resurrect the adapter to AUTHENTICATING.
  it('ignores an authenticated event fired during teardown (status stays disconnected)', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const teardownWait = deferredVoid();
    const { client, onReady } = attachFakeClient(adapter);
    client.destroy = jest.fn().mockReturnValue(teardownWait.promise);

    client.emit('authenticated');
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);

    const teardown = adapter.disconnect();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(jest.getTimerCount()).toBe(0);

    client.emit('authenticated'); // must NOT revive to AUTHENTICATING / re-arm the probe
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(jest.getTimerCount()).toBe(0);

    teardownWait.resolve();
    await teardown;
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onReady).not.toHaveBeenCalled();
  });

  // A 'qr' IPC buffered by a wedged page can flush during the awaited client.destroy() (teardown sets
  // tearingDown + DISCONNECTED first), and must not resurrect the adapter to QR_READY / re-emit a stale QR.
  // The guard returns BEFORE the qrcode encode, so spying on qrcode.toDataURL gives a deterministic check
  // (no timing dependence on the real ~ms encode): guarded => never called; unguarded => called (regression).
  it('ignores a qr event fired during teardown (status stays disconnected, no stale QR emitted)', async () => {
    (qrcode.toDataURL as unknown as jest.Mock).mockClear();
    const adapter = newAdapter();
    const teardownWait = deferredVoid();
    const { client } = attachFakeClient(adapter);
    const onQRCode = jest.fn();
    (adapter as unknown as { callbacks: { onQRCode: jest.Mock } }).callbacks.onQRCode = onQRCode;
    client.destroy = jest.fn().mockReturnValue(teardownWait.promise);

    const teardown = adapter.disconnect();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);

    client.emit('qr', '2@abc'); // buffered QR flushed mid-destroy — must NOT flip to QR_READY
    await Promise.resolve();
    await Promise.resolve();
    expect(qrcode.toDataURL as unknown as jest.Mock).not.toHaveBeenCalled(); // guard short-circuits before the encode
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onQRCode).not.toHaveBeenCalled();

    teardownWait.resolve();
    await teardown;
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onQRCode).not.toHaveBeenCalled();
  });

  // Guards against over-suppression: the legitimate first QR still reaches QR_READY + onQRCode. Await the
  // real completion signal (the onQRCode callback) rather than guessing microtask-flush counts.
  it('emits the normal first qr (status becomes qr_ready and onQRCode is called)', async () => {
    (qrcode.toDataURL as unknown as jest.Mock).mockClear();
    const adapter = newAdapter();
    const { client } = attachFakeClient(adapter);
    const qrDone = deferredVoid();
    const onQRCode = jest.fn(() => qrDone.resolve());
    (adapter as unknown as { callbacks: { onQRCode: jest.Mock } }).callbacks.onQRCode = onQRCode;

    client.emit('qr', '2@abc');
    await qrDone.promise;
    expect(adapter.getStatus()).toBe(EngineStatus.QR_READY);
    expect(onQRCode).toHaveBeenCalledTimes(1);
  });

  // A wedged page can make getState() hang (the exact #251/#273 condition). The probe must keep its
  // own cadence (a hung probe can't stall the loop) and still honor the 90s give-up deadline.
  it('keeps probing and self-heals (clears auth + disconnects) when getState hangs past the deadline', async () => {
    jest.useFakeTimers();
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    const adapter = newAdapter();
    const { client } = attachFakeClient(adapter, {
      getState: jest.fn().mockReturnValue(new Promise<never>(() => {})),
      destroy: jest.fn().mockResolvedValue(undefined),
    });
    const onDisconnected = jest.fn();
    (adapter as unknown as { callbacks: { onDisconnected?: jest.Mock } }).callbacks.onDisconnected = onDisconnected;

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(50_000);
    expect(jest.getTimerCount()).toBe(1); // chain still alive despite the hung probe

    await jest.advanceTimersByTimeAsync(45_000); // ~95s total
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED); // never falsely promoted; self-healed
    expect(jest.getTimerCount()).toBe(0); // gave up at the 90s deadline
    expect(client.getState).toHaveBeenCalledTimes(1); // at-most-one-in-flight guard held
    // Self-heal: the broken auth is cleared and a disconnect surfaced so the lifecycle re-pairs (QR).
    expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('session-sess-1'), { recursive: true, force: true });
    expect(onDisconnected).toHaveBeenCalled();

    rmSpy.mockRestore();
  });

  it('fails terminally on a second stuck-auth cycle (no QR -> timeout -> clear loop)', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    const adapter = newAdapter();
    const onError = jest.fn();
    (adapter as unknown as { callbacks: { onError?: jest.Mock } }).callbacks = { onError };
    const recover = (adapter as unknown as { recoverFromStuckAuth: () => Promise<void> }).recoverFromStuckAuth.bind(
      adapter,
    );

    await recover(); // first stuck cycle: clears + disconnects
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    await recover(); // second: terminal failure, not another clear
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalledTimes(1); // auth cleared only once
    rmSpy.mockRestore();
  });
});

describe('WhatsAppWebJsAdapter.resolveContactPhone (@lid -> phone, #263)', () => {
  // Stub a "ready" adapter with a fake client so we exercise the mapping without a real browser.
  const readyAdapter = (getContactLidAndPhone: jest.Mock): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = { getContactLidAndPhone };
    return adapter;
  };

  it('returns the phone JID stripped to MSISDN digits', async () => {
    const adapter = readyAdapter(jest.fn().mockResolvedValue([{ lid: '123@lid', pn: '628123456789@c.us' }]));
    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628123456789');
  });

  it('returns null when the engine has no mapping (empty result or empty pn)', async () => {
    await expect(readyAdapter(jest.fn().mockResolvedValue([])).resolveContactPhone('123@lid')).resolves.toBeNull();
    await expect(
      readyAdapter(jest.fn().mockResolvedValue([{ lid: '123@lid', pn: '' }])).resolveContactPhone('123@lid'),
    ).resolves.toBeNull();
  });

  it('is best-effort: a thrown engine error resolves to null, not a rejection', async () => {
    const adapter = readyAdapter(jest.fn().mockRejectedValue(new Error('Evaluation failed')));
    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBeNull();
  });
});

describe('WhatsAppWebJsAdapter status methods', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const media = { mimetype: 'image/png', data: 'iVBOR' };
  const options = { recipients: ['628111@c.us'] };
  const STATUS_TTL_MS = 24 * 3_600_000;

  it('postTextStatus posts to status@broadcast with styling in `extra` and returns a StatusResult', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'STATUS1' }, timestamp: 1700000010 });
    const result = await readyAdapter({ sendMessage }).postTextStatus('hello', {
      ...options,
      backgroundColor: '#ff0000',
      font: 2,
    });
    expect(sendMessage).toHaveBeenCalledWith('status@broadcast', 'hello', {
      extra: { backgroundColor: '#ff0000', fontStyle: 2 },
    });
    const ts = new Date(1700000010 * 1000);
    expect(result).toEqual({ statusId: 'STATUS1', timestamp: ts, expiresAt: new Date(ts.getTime() + STATUS_TTL_MS) });
  });

  it.each([['postImageStatus'], ['postVideoStatus']] as const)(
    '%s posts media to status@broadcast with the caption and returns a StatusResult',
    async method => {
      const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'STATUS2' }, timestamp: 1700000011 });
      const result = await readyAdapter({ sendMessage })[method](media, { ...options, caption: 'cap' });
      expect(sendMessage).toHaveBeenCalledWith('status@broadcast', expect.any(MessageMedia), { caption: 'cap' });
      const ts = new Date(1700000011 * 1000);
      expect(result.statusId).toBe('STATUS2');
      expect(result.expiresAt).toEqual(new Date(ts.getTime() + STATUS_TTL_MS));
    },
  );

  it('postTextStatus reads a renamed `$1` id when the dependency has not normalized it', async () => {
    // The id is right there — spending the "posted, id unknown" sentinel on it would hand the caller a
    // statusId that deleteStatus can never revoke, for a status that really is live.
    const sendMessage = jest.fn().mockResolvedValue({ id: { $1: 'STATUS_RENAMED' }, timestamp: 1700000012 });
    const result = await readyAdapter({ sendMessage }).postTextStatus('hello', options);
    expect(result.statusId).toBe('STATUS_RENAMED');
  });

  it('postTextStatus reports an unreadable id as posted-id-unknown rather than inventing one', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ id: { someFutureName: 'X' }, timestamp: 1700000013 });
    const result = await readyAdapter({ sendMessage }).postTextStatus('hello', options);
    // A Message came back, so the post itself is proven — only the id is unreadable.
    expect(result.statusId).toBe('');
  });

  it.each([['postTextStatus'], ['postImageStatus'], ['postVideoStatus']] as const)(
    '%s fails rather than claim a status that may never have been published',
    async method => {
      // whatsapp-web.js resolves undefined when the chat could not be resolved — nothing was posted.
      // Returning a 201 with a fabricated timestamp here is unrecoverable; a visible failure is not.
      const sendMessage = jest.fn().mockResolvedValue(undefined);
      const adapter = readyAdapter({ sendMessage });
      const call =
        method === 'postTextStatus' ? adapter.postTextStatus('hello', options) : adapter[method](media, options);
      // Assert the TYPE, not just the text: a bare Error is a 500 whose body says only "Internal server
      // error" (no global filter — see message-not-found.error.spec.ts), which would silently discard
      // the reason this throw exists to deliver.
      await expect(call).rejects.toBeInstanceOf(InternalServerErrorException);
      await expect(call).rejects.toThrow(/may not have been published/);
    },
  );

  it('deleteStatus revokes via client.revokeStatusMessage(statusId)', async () => {
    const revokeStatusMessage = jest.fn().mockResolvedValue(undefined);
    await readyAdapter({ sendMessage: jest.fn(), revokeStatusMessage }).deleteStatus('STATUS1');
    expect(revokeStatusMessage).toHaveBeenCalledWith('STATUS1');
  });

  const storyBroadcast = {
    getContact: () => Promise.resolve({ id: { _serialized: '628111@c.us' }, name: 'Alice', pushname: 'Alice' }),
    msgs: [
      { id: { _serialized: 'ST1' }, type: 'image', body: 'cap1', timestamp: 1700000020 },
      { id: { _serialized: 'ST2' }, type: 'chat', body: 'hello', timestamp: 1700000021 },
    ],
  };

  it('getContactStatuses reads contact stories via getBroadcasts() mapped to Status[]', async () => {
    const getBroadcasts = jest.fn().mockResolvedValue([storyBroadcast]);
    const result = await readyAdapter({ sendMessage: jest.fn(), getBroadcasts }).getContactStatuses();
    expect(getBroadcasts).toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'ST1',
      contact: { id: '628111@c.us', name: 'Alice', pushName: 'Alice' },
      type: 'image',
      caption: 'cap1',
      timestamp: new Date(1700000020 * 1000),
      expiresAt: new Date(1700000020 * 1000 + 24 * 3_600_000),
    });
    expect(result[1].type).toBe('text');
  });

  it('getContactStatus reads one contact stories via getBroadcastById mapped to Status[]', async () => {
    const getBroadcastById = jest.fn().mockResolvedValue(storyBroadcast);
    const result = await readyAdapter({ sendMessage: jest.fn(), getBroadcastById }).getContactStatus('628111@c.us');
    expect(getBroadcastById).toHaveBeenCalledWith('628111@c.us');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'ST1',
        type: 'image',
        contact: { id: '628111@c.us', name: 'Alice', pushName: 'Alice' },
      }),
    );
  });

  it('getContactStatus returns [] for a contact with no active story (empty Broadcast, no 500)', async () => {
    // getBroadcastById for a contact not currently posting resolves an "empty" Broadcast: the
    // Broadcast constructor only _patches when data is truthy, so id/msgs/getContact are undefined.
    const getBroadcastById = jest.fn().mockResolvedValue({ msgs: undefined });
    const result = await readyAdapter({ sendMessage: jest.fn(), getBroadcastById }).getContactStatus(
      '628999@s.whatsapp.net',
    );
    expect(getBroadcastById).toHaveBeenCalledWith('628999@s.whatsapp.net');
    expect(result).toEqual([]);
  });

  it('getContactStatuses skips empty Broadcasts in the plural path (no crash)', async () => {
    const getBroadcasts = jest.fn().mockResolvedValue([
      { msgs: undefined }, // a contact whose story expired / phantom entry
      storyBroadcast,
    ]);
    const result = await readyAdapter({ sendMessage: jest.fn(), getBroadcasts }).getContactStatuses();
    expect(result).toHaveLength(2); // only the populated broadcast maps
  });
});

describe('resolveWebVersionPin (#251/#488 — explicit pin + auto-resolve current WA-Web build)', () => {
  const orig = { v: process.env.WWEBJS_WEB_VERSION, p: process.env.WWEBJS_WEB_VERSION_REMOTE_PATH };
  const fetcherFor = (currentVersion: unknown, ok = true) =>
    jest.fn(() =>
      Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve({ currentVersion }) }),
    ) as unknown as typeof fetch;

  beforeEach(() => __resetWebVersionCache());
  afterEach(() => {
    __resetWebVersionCache();
    if (orig.v === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = orig.v;
    if (orig.p === undefined) delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    else process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = orig.p;
  });

  it('pins the explicit version without any network call when set', async () => {
    delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    process.env.WWEBJS_WEB_VERSION = '2.3000.1041203030-alpha';
    const fetcher = fetcherFor('SHOULD-NOT-BE-USED');
    expect(await resolveWebVersionPin(fetcher)).toEqual({
      webVersion: '2.3000.1041203030-alpha',
      webVersionCache: {
        type: 'remote',
        remotePath:
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1041203030-alpha.html',
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honors a custom WWEBJS_WEB_VERSION_REMOTE_PATH template ({version} placeholder)', async () => {
    process.env.WWEBJS_WEB_VERSION = '2.9999.0';
    process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://cdn.example.com/wa/{version}.html';
    expect((await resolveWebVersionPin(fetcherFor('x')))?.webVersionCache.remotePath).toBe(
      'https://cdn.example.com/wa/2.9999.0.html',
    );
  });

  it('"off" disables pinning (native whatsapp-web.js auto-select) with no network call', async () => {
    process.env.WWEBJS_WEB_VERSION = 'off';
    const fetcher = fetcherFor('x');
    expect(await resolveWebVersionPin(fetcher)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['', 'auto', 'latest'])(
    'auto-resolves the current wa-version build when WWEBJS_WEB_VERSION=%p (the #488 fix)',
    async value => {
      if (value === '') delete process.env.WWEBJS_WEB_VERSION;
      else process.env.WWEBJS_WEB_VERSION = value;
      const pin = await resolveWebVersionPin(fetcherFor('2.3000.1042251103-alpha'));
      expect(pin?.webVersion).toBe('2.3000.1042251103-alpha');
      expect(pin?.webVersionCache.remotePath).toContain('2.3000.1042251103-alpha.html');
    },
  );

  it('falls back to native auto-select (undefined) when the wa-version fetch fails', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    expect(await resolveWebVersionPin(fetcherFor(null, false))).toBeUndefined();
  });

  it('caches the resolved current version (fetches once across calls)', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    const fetcher = fetcherFor('2.3000.1042251103-alpha');
    await resolveWebVersionPin(fetcher);
    await resolveWebVersionPin(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rate-limits a transient failure (no refetch within the backoff window) but does NOT cache it permanently', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    expect(await resolveWebVersionPin(fetcherFor(null, false))).toBeUndefined(); // transient failure

    // Within the backoff window: a 2nd call returns undefined WITHOUT another network fetch.
    const blocked = fetcherFor('2.3000.1042251103-alpha');
    expect(await resolveWebVersionPin(blocked)).toBeUndefined();
    expect(blocked).not.toHaveBeenCalled();

    // After the window elapses (reset simulates it / a process restart): it retries and resolves —
    // the failure was never permanently cached (#488 must-fix preserved).
    __resetWebVersionCache();
    const ok = fetcherFor('2.3000.1042251103-alpha');
    const pin = await resolveWebVersionPin(ok);
    expect(pin?.webVersion).toBe('2.3000.1042251103-alpha');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent in-flight resolves into a single fetch', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    const fetcher = fetcherFor('2.3000.1042251103-alpha');
    const [a, b] = await Promise.all([resolveWebVersionPin(fetcher), resolveWebVersionPin(fetcher)]);
    expect(a?.webVersion).toBe('2.3000.1042251103-alpha');
    expect(b?.webVersion).toBe('2.3000.1042251103-alpha');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('getEffectiveWebVersionInfo (#488 — surface the running WA-Web build to the dashboard)', () => {
  const orig = process.env.WWEBJS_WEB_VERSION;
  beforeEach(() => __resetWebVersionCache());
  afterEach(() => {
    __resetWebVersionCache();
    if (orig === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = orig;
  });

  it('reports an explicitly pinned env version', () => {
    process.env.WWEBJS_WEB_VERSION = '2.3000.1041203030-alpha';
    expect(getEffectiveWebVersionInfo()).toEqual({ version: '2.3000.1041203030-alpha', source: 'pinned' });
  });

  it('reports native auto-select for "off"', () => {
    process.env.WWEBJS_WEB_VERSION = 'off';
    expect(getEffectiveWebVersionInfo()).toEqual({ version: null, source: 'native' });
  });

  it('reports the auto-resolved current build once resolution has run', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    expect(getEffectiveWebVersionInfo()).toEqual({ version: null, source: 'auto' });
    await resolveWebVersionPin(
      jest.fn(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ currentVersion: '2.3000.9-alpha' }) }),
      ) as never,
    );
    expect(getEffectiveWebVersionInfo()).toEqual({ version: '2.3000.9-alpha', source: 'auto' });
  });
});

describe('resolveAuthTimeoutMs (#353 — configurable first-boot init wait)', () => {
  const orig = process.env.WWEBJS_AUTH_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    else process.env.WWEBJS_AUTH_TIMEOUT_MS = orig;
  });

  it('returns undefined (wwebjs default) when unset', () => {
    delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    expect(resolveAuthTimeoutMs()).toBeUndefined();
  });

  it('parses a positive integer milliseconds value', () => {
    process.env.WWEBJS_AUTH_TIMEOUT_MS = '120000';
    expect(resolveAuthTimeoutMs()).toBe(120000);
  });

  it('ignores non-positive-integer values (falls back to the default)', () => {
    for (const bad of ['', '  ', '0', '-5', '1.5', 'abc', '60s']) {
      process.env.WWEBJS_AUTH_TIMEOUT_MS = bad;
      expect(resolveAuthTimeoutMs()).toBeUndefined();
    }
  });

  it('ignores all-digit values that are not finite safe integers (falls back to the default)', () => {
    // A huge digit string coerces to Infinity; MAX_SAFE_INTEGER + 1 is a finite but unsafe integer.
    // Both pass the /^\d+$/ shape check, so without a numeric guard they would reach whatsapp-web.js
    // as an effectively unbounded inject wait.
    for (const bad of ['9'.repeat(352), String(Number.MAX_SAFE_INTEGER + 1)]) {
      process.env.WWEBJS_AUTH_TIMEOUT_MS = bad;
      expect(resolveAuthTimeoutMs()).toBeUndefined();
    }
  });

  it('accepts large but safe integer millisecond values', () => {
    process.env.WWEBJS_AUTH_TIMEOUT_MS = '600000';
    expect(resolveAuthTimeoutMs()).toBe(600000);
  });
});

describe('WhatsAppWebJsAdapter inbound media (MEDIA_DOWNLOAD_ENABLED=false)', () => {
  const ENV = 'MEDIA_DOWNLOAD_ENABLED';
  const orig = process.env[ENV];

  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  it('skips media download and omits the media field when disabled', async () => {
    process.env[ENV] = 'false';

    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-media-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessage = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessage };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();

    const mockMsg = {
      id: { _serialized: 'MEDIA_OFF_1' },
      from: '628111@c.us',
      to: '628111@c.us',
      body: '',
      type: 'image',
      timestamp: 1700000050,
      fromMe: false,
      hasMedia: true,
      _data: { mimetype: 'image/png', size: 5000 },
      getContact: jest.fn().mockResolvedValue(null),
      hasQuotedMsg: false,
    };

    client.emit('message', mockMsg);
    await new Promise(r => setImmediate(r));

    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as {
      media?: { omitted?: boolean; mimetype?: string; sizeBytes?: number };
      type: string;
    };
    expect(msg.type).toBe('image');
    expect(msg.media).toBeDefined();
    expect(msg.media?.omitted).toBe(true);
    expect(msg.media?.mimetype).toBe('image/png');
    expect(msg.media?.sizeBytes).toBe(5000);
  });

  it('surfaces call detail on a live incoming call_log message (#494)', async () => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-call-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessage = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessage };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();

    const mockMsg = {
      id: { _serialized: 'CALL_1' },
      from: '628111@c.us',
      to: '628111@c.us',
      body: '',
      type: 'call_log',
      timestamp: 1700000060,
      fromMe: false,
      hasMedia: false,
      _data: { isVideoCall: true }, // no callDuration on an incoming call => missed
      getContact: jest.fn().mockResolvedValue(null),
      hasQuotedMsg: false,
    };

    client.emit('message', mockMsg);
    await new Promise(r => setImmediate(r));

    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { call?: { video: boolean; missed: boolean } };
    expect(msg.call).toEqual({ video: true, missed: true });
  });

  it('enriches an own-send (message_create) echo with the media payload', async () => {
    // buildIncomingMessageBase is sync and carries no media; without enrichment a phone-composed
    // image persists/renders as a bare 📎 marker. The echo must reuse the same capped download path
    // as the incoming handler, so the payload lands on the outgoing row.
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-echo-media',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessageCreate = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessageCreate };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();

    const mockMsg = {
      id: { _serialized: 'OWN_MEDIA_1' },
      from: '628123@c.us',
      to: '628111@c.us',
      body: '',
      type: 'image',
      timestamp: 1700000070,
      fromMe: true,
      hasMedia: true,
      _data: { mimetype: 'image/png', size: 3 },
      downloadMedia: jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD', filename: 'a.png' }),
      getContact: jest.fn().mockResolvedValue(null),
      hasQuotedMsg: false,
    };

    client.emit('message_create', mockMsg);
    // The echo runs async (media download through the limiter) — flush the chain.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessageCreate.mock.calls[0][0] as {
      media?: { mimetype?: string; data?: string; omitted?: boolean };
    };
    expect(msg.media?.mimetype).toBe('image/png');
    expect(msg.media?.data).toBe('QUJD');
    expect(msg.media?.omitted).toBeUndefined();
  });

  it('still emits the echo (without media) when the own-send media download fails', async () => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-echo-media-fail',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessageCreate = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessageCreate };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();

    const mockMsg = {
      id: { _serialized: 'OWN_MEDIA_2' },
      from: '628123@c.us',
      to: '628111@c.us',
      body: '',
      type: 'image',
      timestamp: 1700000071,
      fromMe: true,
      hasMedia: true,
      _data: { mimetype: 'image/png', size: 3 },
      downloadMedia: jest.fn().mockRejectedValue(new Error('media gone')),
      getContact: jest.fn().mockResolvedValue(null),
      hasQuotedMsg: false,
    };

    client.emit('message_create', mockMsg);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessageCreate.mock.calls[0][0] as { media?: unknown };
    // The failure is contained at the call site: the echo still fires, just without the media field
    // (the omitted marker is synthesized downstream, in SessionService's persistence).
    expect(msg.media).toBeUndefined();
  });
});

describe('WhatsAppWebJsAdapter message_reaction (id resolution across WA Web builds)', () => {
  const wireReactionHandler = (): { onMessageReaction: jest.Mock; client: EventEmitter } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-reaction-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: 'me@c.us', user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessageReaction = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessageReaction };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
    return { onMessageReaction, client };
  };

  const reactionArg = (mock: jest.Mock): { messageId: string; chatId: string } => {
    const calls = mock.mock.calls as Array<[{ messageId: string; chatId: string }]>;
    return calls[0][0];
  };

  const emitReaction = (client: EventEmitter, msgId: unknown): void => {
    client.emit('message_reaction', {
      msgId,
      id: { remote: 'peer@c.us' },
      reaction: '👍',
      senderId: 'peer@c.us',
    });
  };

  it('reads _serialized on a healthy WA Web build', () => {
    const { onMessageReaction, client } = wireReactionHandler();

    emitReaction(client, { _serialized: 'REACTED_MSG' });

    expect(reactionArg(onMessageReaction).messageId).toBe('REACTED_MSG');
  });

  it('falls back to $1 on a build that renamed _serialized (#747)', () => {
    const { onMessageReaction, client } = wireReactionHandler();

    // `Reaction` passes its keys straight through, so upstream's id normalization never reaches it —
    // this fallback is the only thing keeping reactions attributable on an affected build.
    emitReaction(client, { $1: 'REACTED_MSG_RENAMED' });

    expect(reactionArg(onMessageReaction).messageId).toBe('REACTED_MSG_RENAMED');
  });

  it('emits the empty no-id sentinel rather than undefined when neither field resolves', () => {
    const { onMessageReaction, client } = wireReactionHandler();

    emitReaction(client, {});

    // Never undefined: downstream looks the message up by this id, and TypeORM drops an undefined
    // condition from the where-clause — which would match an unrelated row.
    expect(reactionArg(onMessageReaction).messageId).toBe('');
  });
});

describe('WhatsAppWebJsAdapter message_revoke_everyone (forwards the original deleted id as revokedId)', () => {
  const wireRevokeHandler = (): { onMessageRevoked: jest.Mock; client: EventEmitter } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-revoke-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: 'me@c.us', user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessageRevoked = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessageRevoked };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
    return { onMessageRevoked, client };
  };

  it('emits revokedId from `before` (the original) distinct from `id` (the revocation notification)', () => {
    const { onMessageRevoked, client } = wireRevokeHandler();

    client.emit(
      'message_revoke_everyone',
      { id: { _serialized: 'REVOKE_NOTIF' }, from: 'peer@c.us', to: 'me@c.us', timestamp: 1700000070 },
      { id: { _serialized: 'ORIGINAL_MSG' } },
    );

    expect(onMessageRevoked).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const revoked = onMessageRevoked.mock.calls[0][0] as {
      id: string;
      revokedId?: string;
      chatId: string;
      type: string;
      body: string;
    };
    expect(revoked.id).toBe('REVOKE_NOTIF');
    expect(revoked.revokedId).toBe('ORIGINAL_MSG');
    expect(revoked.chatId).toBe('peer@c.us'); // incoming: chatId is the peer, not self
    expect(revoked.type).toBe('revoked');
    expect(revoked.body).toBe('');
  });

  it('leaves revokedId undefined when whatsapp-web.js has no `before` (original not in local store)', () => {
    const { onMessageRevoked, client } = wireRevokeHandler();

    client.emit(
      'message_revoke_everyone',
      { id: { _serialized: 'REVOKE_NOTIF_2' }, from: 'peer@c.us', to: 'me@c.us', timestamp: 1700000071 },
      undefined,
    );

    expect(onMessageRevoked).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const revoked = onMessageRevoked.mock.calls[0][0] as { id: string; revokedId?: string };
    expect(revoked.id).toBe('REVOKE_NOTIF_2');
    expect(revoked.revokedId).toBeUndefined();
  });

  it('reads renamed `$1` ids on both sides (#747)', () => {
    // `revokedId` needs this even on a patched tree: Client.js overwrites the normalized id with a raw
    // spread of `protocolMessageKey`, which neither normalization layer touches. Losing it strands the
    // revocation — the UPDATE matches no row and the deleted body stays in the DB.
    const { onMessageRevoked, client } = wireRevokeHandler();

    client.emit(
      'message_revoke_everyone',
      { id: { $1: 'REVOKE_NOTIF_RENAMED' }, from: 'peer@c.us', to: 'me@c.us', timestamp: 1700000072 },
      { id: { $1: 'ORIGINAL_RENAMED' } },
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const revoked = onMessageRevoked.mock.calls[0][0] as { id: string; revokedId?: string };
    expect(revoked.id).toBe('REVOKE_NOTIF_RENAMED');
    expect(revoked.revokedId).toBe('ORIGINAL_RENAMED');
  });
});

describe('WhatsAppWebJsAdapter message_edit', () => {
  const wireEditHandler = (): { onMessageEdited: jest.Mock; client: EventEmitter } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-edit-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: 'me@c.us', user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessageEdited = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessageEdited };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
    return { onMessageEdited, client };
  };

  it('emits onMessageEdited with the new body and mapped fields', () => {
    const { onMessageEdited, client } = wireEditHandler();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1700000089123);

    try {
      client.emit(
        'message_edit',
        {
          id: { _serialized: 'MSG_EDIT_1' },
          from: 'peer@c.us',
          to: 'me@c.us',
          author: 'peer@c.us',
          body: 'Old text',
          type: 'chat',
          fromMe: false,
          hasMedia: false,
          mentionedIds: ['mentioned@c.us'],
          timestamp: 1700000080,
        },
        'Edited new text',
        'Old text',
      );
    } finally {
      now.mockRestore();
    }

    expect(onMessageEdited).toHaveBeenCalledTimes(1);
    const calls = onMessageEdited.mock.calls as Array<[EditedMessage]>;
    expect(calls[0][0]).toEqual({
      messageId: 'MSG_EDIT_1',
      chatId: 'peer@c.us',
      body: 'Edited new text',
      senderId: 'peer@c.us',
      from: 'peer@c.us',
      to: 'me@c.us',
      fromMe: false,
      isGroup: false,
      type: 'text',
      hasMedia: false,
      author: 'peer@c.us',
      mentionedIds: ['mentioned@c.us'],
      timestamp: 1700000089,
    });
  });
});

describe('WhatsAppWebJsAdapter group notifications (group_join / group_leave / group_update)', () => {
  const wireGroupHandler = (): { onGroupEvent: jest.Mock; client: EventEmitter } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-group-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: 'me@c.us', user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onGroupEvent = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onGroupEvent };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
    return { onGroupEvent, client };
  };

  const groupArg = (mock: jest.Mock): GroupEvent => {
    const calls = mock.mock.calls as Array<[GroupEvent]>;
    return calls[0][0];
  };

  it('maps group_join to a neutral join GroupEvent with the notification timestamp', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_join', {
      id: { _serialized: 'NOTIF_JOIN' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: ['628111@c.us', '628222@c.us'],
      body: '',
      timestamp: 1700000100,
      type: 'add',
    });

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    // wwebjs ids are already neutral (@c.us/@g.us): they pass through untranslated. A join
    // carries no metadata delta, so `changes` stays absent (kind is carried by the event name).
    expect(groupArg(onGroupEvent)).toEqual({
      kind: 'join',
      groupId: '120363@g.us',
      actorId: 'admin@c.us',
      participantIds: ['628111@c.us', '628222@c.us'],
      timestamp: 1700000100,
    });
  });

  it('maps group_leave to a neutral leave GroupEvent', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_leave', {
      id: { _serialized: 'NOTIF_LEAVE' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: ['628111@c.us'],
      body: '',
      timestamp: 1700000200,
      type: 'remove',
    });

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(groupArg(onGroupEvent)).toEqual({
      kind: 'leave',
      groupId: '120363@g.us',
      actorId: 'admin@c.us',
      participantIds: ['628111@c.us'],
      timestamp: 1700000200,
    });
  });

  it('omits actorId when the notification has no author', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_join', {
      id: { _serialized: 'NOTIF_NOAUTHOR' },
      chatId: '120363@g.us',
      author: '',
      recipientIds: ['628111@c.us'],
      body: '',
      timestamp: 1700000250,
      type: 'invite',
    });

    expect(groupArg(onGroupEvent).actorId).toBeUndefined();
  });

  it('falls back to receipt time when the notification carries no usable timestamp', () => {
    const { onGroupEvent, client } = wireGroupHandler();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1700000300123);

    try {
      client.emit('group_join', {
        id: { _serialized: 'NOTIF_NOTS' },
        chatId: '120363@g.us',
        author: 'admin@c.us',
        recipientIds: ['628111@c.us'],
        body: '',
        type: 'add',
      });
    } finally {
      now.mockRestore();
    }

    expect(groupArg(onGroupEvent).timestamp).toBe(1700000300);
  });

  it('coerces $1-renamed recipientIds entries (#747) and drops unreadable ones', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_join', {
      id: { _serialized: 'NOTIF_RENAMED' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      // GroupNotification._patch assigns data.recipients straight through, outside upstream's id
      // normalization — a renamed WA Web build hands us raw id objects here.
      recipientIds: [{ $1: '628111@c.us' }, { _serialized: '628222@c.us' }, { someFutureName: 'x' }, '628333@c.us'],
      body: '',
      timestamp: 1700000400,
      type: 'add',
    });

    expect(groupArg(onGroupEvent).participantIds).toEqual(['628111@c.us', '628222@c.us', '628333@c.us']);
  });

  it('maps group_update subject/description bodies into the changes delta', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_update', {
      id: { _serialized: 'NOTIF_SUBJ' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: [],
      body: 'New group name',
      timestamp: 1700000500,
      type: 'subject',
    });
    client.emit('group_update', {
      id: { _serialized: 'NOTIF_DESC' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: [],
      body: 'New description',
      timestamp: 1700000501,
      type: 'description',
    });

    const calls = onGroupEvent.mock.calls as Array<[GroupEvent]>;
    expect(calls[0][0]).toMatchObject({ kind: 'update', changes: { subject: 'New group name' } });
    expect(calls[1][0]).toMatchObject({ kind: 'update', changes: { description: 'New description' } });
  });

  it('maps group_update announce/restrict on-off bodies to the neutral booleans', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_update', {
      id: { _serialized: 'NOTIF_ANNOUNCE' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: [],
      body: 'on',
      timestamp: 1700000600,
      type: 'announce',
    });
    client.emit('group_update', {
      id: { _serialized: 'NOTIF_RESTRICT' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: [],
      body: 'off',
      timestamp: 1700000601,
      type: 'restrict',
    });

    const calls = onGroupEvent.mock.calls as Array<[GroupEvent]>;
    expect(calls[0][0].changes).toEqual({ announce: true });
    expect(calls[1][0].changes).toEqual({ locked: false });
  });

  it('still emits an update with empty changes when the subtype is uninterpretable (picture)', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_update', {
      id: { _serialized: 'NOTIF_PIC' },
      chatId: '120363@g.us',
      author: 'admin@c.us',
      recipientIds: [],
      body: '',
      timestamp: 1700000700,
      type: 'picture',
    });

    // Never dropped silently: the occurrence reaches consumers, just without guessed fields.
    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(groupArg(onGroupEvent)).toMatchObject({ kind: 'update', groupId: '120363@g.us', changes: {} });
  });

  it('emits a join with empty participantIds when recipientIds is missing (malformed payload)', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    expect(() =>
      client.emit('group_join', {
        id: { _serialized: 'NOTIF_MALFORMED' },
        chatId: '120363@g.us',
        author: 'admin@c.us',
        body: '',
        timestamp: 1700000800,
        type: 'add',
      }),
    ).not.toThrow();

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(groupArg(onGroupEvent).participantIds).toEqual([]);
  });

  it('logs and drops a null notification instead of throwing into the client emitter', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    expect(() => client.emit('group_update', null)).not.toThrow();
    expect(onGroupEvent).not.toHaveBeenCalled();
  });

  it('drops a notification without a chatId before building the payload', () => {
    const { onGroupEvent, client } = wireGroupHandler();

    client.emit('group_join', {
      id: { _serialized: 'NOTIF_NOCHAT' },
      author: 'admin@c.us',
      recipientIds: ['628111@c.us'],
      body: '',
      timestamp: 1700000900,
      type: 'add',
    });

    expect(onGroupEvent).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebJsAdapter call event + rejectCall', () => {
  const wireCallHandler = (): { adapter: WhatsAppWebJsAdapter; onCall: jest.Mock; client: EventEmitter } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-call-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: 'me@c.us', user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
      destroy: jest.fn().mockResolvedValue(undefined),
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onCall = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onCall };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
    return { adapter, onCall, client };
  };

  const liveCall = (over: Record<string, unknown> = {}) => ({
    id: 'CALL1',
    from: '628111@c.us',
    timestamp: 1700000200,
    isVideo: false,
    isGroup: false,
    fromMe: false,
    canHandleLocally: false,
    webClientShouldHandle: false,
    participants: {},
    reject: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  const firstCallEvent = (mock: jest.Mock): IncomingCallEvent => {
    const calls = mock.mock.calls as Array<[IncomingCallEvent]>;
    if (!calls[0]) throw new Error('Expected a call event');
    return calls[0][0];
  };

  it('maps the call event to a neutral IncomingCallEvent', () => {
    const { onCall, client } = wireCallHandler();

    client.emit('call', liveCall({ isVideo: true }));

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(firstCallEvent(onCall)).toEqual({
      callId: 'CALL1',
      from: '628111@c.us',
      isVideo: true,
      isGroup: false,
      timestamp: 1700000200,
    });
  });

  it('skips own-account (fromMe) calls — they are outgoing, not incoming', () => {
    const { onCall, client } = wireCallHandler();

    client.emit('call', liveCall({ fromMe: true }));

    expect(onCall).not.toHaveBeenCalled();
  });

  it.each([{ id: '' }, { id: undefined }, { from: '' }, { from: undefined }, null])(
    'drops a malformed call (%o) — nothing emitted, nothing cached',
    async malformed => {
      const { adapter, onCall, client } = wireCallHandler();

      client.emit('call', malformed === null ? null : liveCall(malformed as Record<string, unknown>));

      expect(onCall).not.toHaveBeenCalled();
      await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    },
  );

  it('drops a call arriving during teardown', () => {
    const { adapter, onCall, client } = wireCallHandler();
    (adapter as unknown as { tearingDown: boolean }).tearingDown = true;

    client.emit('call', liveCall());

    expect(onCall).not.toHaveBeenCalled();
  });

  it('rejectCall rejects the cached live call and evicts it (second reject -> not found)', async () => {
    const { adapter, client } = wireCallHandler();
    const call = liveCall();
    client.emit('call', call);

    await adapter.rejectCall('CALL1');

    expect(call.reject).toHaveBeenCalledTimes(1);
    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
  });

  it('rejectCall on an unknown id throws CallNotFoundError (HTTP 404)', async () => {
    const { adapter } = wireCallHandler();

    await expect(adapter.rejectCall('NOPE')).rejects.toBeInstanceOf(CallNotFoundError);
  });

  it('rejectCall on an expired entry throws CallNotFoundError without touching the call', async () => {
    const { adapter, client } = wireCallHandler();
    const call = liveCall();
    client.emit('call', call);
    // Age the cached entry past the TTL (calls ring ~a minute; the handle dies with the call).
    const cache = (adapter as unknown as { liveCalls: Map<string, { expiresAt: number }> }).liveCalls;
    cache.get('CALL1')!.expiresAt = Date.now() - 1;

    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('teardown clears the live-call cache (reject after disconnect -> not found)', async () => {
    const { adapter, client } = wireCallHandler();
    const call = liveCall();
    client.emit('call', call);

    await adapter.disconnect();

    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('logs and drops a malformed call instead of throwing into the client emitter', () => {
    const { onCall, client } = wireCallHandler();

    expect(() => client.emit('call', null)).not.toThrow();
    expect(onCall).not.toHaveBeenCalled();
  });
});

describe('outbound mentions (#530)', () => {
  const ready = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const sentMessage = { id: { _serialized: 'OUT1' }, timestamp: 1700000001 };

  it('sendTextMessage forwards mentions as a wwebjs option (WIDs pass through)', async () => {
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ sendMessage }).sendTextMessage('120@g.us', 'hi @62811', ['62811@c.us']);
    expect(sendMessage).toHaveBeenCalledWith('120@g.us', 'hi @62811', { mentions: ['62811@c.us'] });
  });

  it('sendTextMessage sends no options object when there are no mentions (no behavior change)', async () => {
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ sendMessage }).sendTextMessage('120@g.us', 'plain');
    expect(sendMessage).toHaveBeenCalledWith('120@g.us', 'plain');
  });

  it('sendImageMessage forwards media.mentions alongside the caption', async () => {
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ sendMessage }).sendImageMessage('120@g.us', {
      mimetype: 'image/png',
      data: Buffer.from([1]).toString('base64'),
      caption: 'look @62811',
      mentions: ['62811@c.us'],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      '120@g.us',
      expect.anything(),
      expect.objectContaining({ caption: 'look @62811', mentions: ['62811@c.us'] }),
    );
  });
});

describe('outbound voice note (PTT)', () => {
  const ready = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const sentMessage = { id: { _serialized: 'OUT1' }, timestamp: 1700000001 };

  it('sendAudioMessage with ptt passes sendAudioAsVoice:true', async () => {
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ sendMessage }).sendAudioMessage('628@c.us', {
      mimetype: 'audio/ogg; codecs=opus',
      data: Buffer.from([1]).toString('base64'),
      ptt: true,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      '628@c.us',
      expect.anything(),
      expect.objectContaining({ sendAudioAsVoice: true }),
    );
  });

  it('sendAudioMessage without ptt passes no sendAudioAsVoice option', async () => {
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ sendMessage }).sendAudioMessage('628@c.us', {
      mimetype: 'audio/mpeg',
      data: Buffer.from([1]).toString('base64'),
    });
    expect(sendMessage).toHaveBeenCalledWith(
      '628@c.us',
      expect.anything(),
      expect.not.objectContaining({ sendAudioAsVoice: true }),
    );
  });
});

describe('LID resolution for individual sends (#573 — WhatsApp @c.us → @lid migration)', () => {
  const ready = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const sentMessage = { id: { _serialized: 'OUT1' }, timestamp: 1700000001 };

  it('sendTextMessage resolves a migrated @c.us recipient to its @lid before sending', async () => {
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ getNumberId, sendMessage }).sendTextMessage('529934031058@c.us', 'hi');
    expect(getNumberId).toHaveBeenCalledWith('529934031058@c.us');
    expect(sendMessage).toHaveBeenCalledWith('159442138038327@lid', 'hi');
  });

  it('leaves a @g.us group id untouched (no LID lookup)', async () => {
    const getNumberId = jest.fn();
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ getNumberId, sendMessage }).sendTextMessage('120@g.us', 'hi');
    expect(getNumberId).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('120@g.us', 'hi');
  });

  it('falls back to the original id when getNumberId returns null (unregistered/unmigrated)', async () => {
    const getNumberId = jest.fn().mockResolvedValue(null);
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ getNumberId, sendMessage }).sendTextMessage('628@c.us', 'hi');
    expect(sendMessage).toHaveBeenCalledWith('628@c.us', 'hi');
  });

  it('never blocks the send when resolution throws (best-effort)', async () => {
    const getNumberId = jest.fn().mockRejectedValue(new Error('network'));
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ getNumberId, sendMessage }).sendTextMessage('628@c.us', 'hi');
    expect(sendMessage).toHaveBeenCalledWith('628@c.us', 'hi');
  });

  it('resolves the recipient on media sends too (sendImageMessage)', async () => {
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await ready({ getNumberId, sendMessage }).sendImageMessage('529934031058@c.us', {
      mimetype: 'image/png',
      data: Buffer.from([1]).toString('base64'),
    });
    expect(sendMessage).toHaveBeenCalledWith('159442138038327@lid', expect.anything(), expect.anything());
  });

  it('resolves the recipient on the typing path (sendChatState) so it no longer errors', async () => {
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const sendStateTyping = jest.fn().mockResolvedValue(undefined);
    const getChatById = jest.fn().mockResolvedValue({ sendStateTyping });
    await ready({ getNumberId, getChatById }).sendChatState('529934031058@c.us', 'typing');
    expect(getChatById).toHaveBeenCalledWith('159442138038327@lid');
    expect(sendStateTyping).toHaveBeenCalled();
  });

  it('caches a resolved @lid so a later getNumberId failure still sends to the @lid, not @c.us (#580)', async () => {
    // getNumberId is flaky: it resolves the first time, then throws `t: t` (a WhatsApp Web internal
    // error). Without a cache the second send falls back to @c.us and 500s with `No LID for user`.
    const getNumberId = jest
      .fn()
      .mockResolvedValueOnce({ _serialized: '159442138038327@lid' })
      .mockRejectedValueOnce(new Error('t: t'));
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    const adapter = ready({ getNumberId, sendMessage });
    await adapter.sendTextMessage('529934031058@c.us', 'first');
    await adapter.sendTextMessage('529934031058@c.us', 'second');
    // Second send reused the cached lid instead of re-querying the flaky resolver.
    expect(getNumberId).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, '159442138038327@lid', 'first');
    expect(sendMessage).toHaveBeenNthCalledWith(2, '159442138038327@lid', 'second');
  });

  it('does not cache a non-resolution (getNumberId null) — keeps retrying for that contact', async () => {
    const getNumberId = jest.fn().mockResolvedValue(null);
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    const adapter = ready({ getNumberId, sendMessage });
    await adapter.sendTextMessage('628@c.us', 'a');
    await adapter.sendTextMessage('628@c.us', 'b');
    expect(getNumberId).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, '628@c.us', 'a');
    expect(sendMessage).toHaveBeenNthCalledWith(2, '628@c.us', 'b');
  });

  it('caches a confirmed non-migrated @c.us so repeat sends do not re-probe getNumberId (#580 perf)', async () => {
    // getNumberId confirms the contact is not migrated (echoes the @c.us). That is a stable fact,
    // so it must be cached — otherwise every ordinary send re-runs the rate-limited existence probe.
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '628@c.us' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    const adapter = ready({ getNumberId, sendMessage });
    await adapter.sendTextMessage('628@c.us', 'a');
    await adapter.sendTextMessage('628@c.us', 'b');
    expect(getNumberId).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, '628@c.us', 'a');
    expect(sendMessage).toHaveBeenNthCalledWith(2, '628@c.us', 'b');
  });

  it('re-resolves and retries once when a send fails with "No LID for user" (contact migrated mid-session)', async () => {
    // First resolution said non-migrated (@c.us) and was cached; the contact then migrated, so the
    // send fails with `No LID for user`. The adapter evicts, re-resolves to the new @lid, and retries.
    const getNumberId = jest
      .fn()
      .mockResolvedValueOnce({ _serialized: '628@c.us' })
      .mockResolvedValueOnce({ _serialized: '999@lid' });
    const sendMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('No LID for user'))
      .mockResolvedValueOnce(sentMessage);
    const adapter = ready({ getNumberId, sendMessage });
    const res = await adapter.sendTextMessage('628@c.us', 'x');
    expect(sendMessage).toHaveBeenNthCalledWith(1, '628@c.us', 'x');
    expect(sendMessage).toHaveBeenNthCalledWith(2, '999@lid', 'x');
    expect(getNumberId).toHaveBeenCalledTimes(2);
    expect(res.id).toBe('OUT1');
  });

  it('does not retry when re-resolution yields the same id (no pointless second send)', async () => {
    const getNumberId = jest.fn().mockResolvedValue(null); // unresolvable → fallback stays @c.us
    const sendMessage = jest.fn().mockRejectedValue(new Error('No LID for user'));
    const adapter = ready({ getNumberId, sendMessage });
    await expect(adapter.sendTextMessage('628@c.us', 'x')).rejects.toThrow('No LID for user');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not retry on a non-LID send error', async () => {
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '999@lid' });
    const sendMessage = jest.fn().mockRejectedValue(new Error('rate limited'));
    const adapter = ready({ getNumberId, sendMessage });
    await expect(adapter.sendTextMessage('628@c.us', 'x')).rejects.toThrow('rate limited');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getNumberId).toHaveBeenCalledTimes(1);
  });

  it('reply routes its send leg to the resolved @lid (#583 R1)', async () => {
    const reply = jest.fn().mockResolvedValue(sentMessage);
    const quoted = { id: { _serialized: 'Q1' }, reply };
    const getChatById = jest.fn().mockResolvedValue({ fetchMessages: jest.fn().mockResolvedValue([quoted]) });
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    await ready({ getChatById, getNumberId }).replyToMessage('529934031058@c.us', 'Q1', 'hi');
    expect(reply).toHaveBeenCalledWith('hi', '159442138038327@lid');
  });

  it('reply is unchanged for a non-migrated contact (#583 R1)', async () => {
    const reply = jest.fn().mockResolvedValue(sentMessage);
    const quoted = { id: { _serialized: 'Q1' }, reply };
    const getChatById = jest.fn().mockResolvedValue({ fetchMessages: jest.fn().mockResolvedValue([quoted]) });
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '628@c.us' });
    await ready({ getChatById, getNumberId }).replyToMessage('628@c.us', 'Q1', 'hi');
    expect(reply).toHaveBeenCalledWith('hi', '628@c.us');
  });

  it('forward routes to the resolved @lid and recovers the id from that chat (#583 R1)', async () => {
    const forward = jest.fn().mockResolvedValue(undefined);
    const srcMsg = { id: { _serialized: 'M1' }, forward };
    const srcChat = { fetchMessages: jest.fn().mockResolvedValue([srcMsg]) };
    const destChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'OUT1' }, timestamp: 123 }]) };
    const getChatById = jest.fn().mockResolvedValueOnce(srcChat).mockResolvedValueOnce(destChat);
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const res = await ready({ getChatById, getNumberId }).forwardMessage('src@c.us', '529934031058@c.us', 'M1');
    expect(forward).toHaveBeenCalledWith('159442138038327@lid');
    expect(getChatById).toHaveBeenNthCalledWith(2, '159442138038327@lid');
    expect(res.id).toBe('OUT1');
  });
});

describe('editMessage', () => {
  const ready = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const chatWith = (messages: unknown[]) => ({
    getChatById: jest.fn().mockResolvedValue({ fetchMessages: jest.fn().mockResolvedValue(messages) }),
  });

  it('edits a message found by _serialized id and returns its (unchanged) id', async () => {
    const edit = jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1700000002 });
    const adapter = ready(chatWith([{ id: { _serialized: 'M1', id: 'RAW1' }, edit }]));
    const res = await adapter.editMessage('628@c.us', 'M1', 'new body');
    expect(edit).toHaveBeenCalledWith('new body');
    expect(res).toEqual({ id: 'M1', timestamp: 1700000002 });
  });

  it('also matches the bare id.id fallback (like deleteMessage)', async () => {
    const edit = jest.fn().mockResolvedValue({ id: { _serialized: 'true_628@c.us_RAW1' }, timestamp: 1700000002 });
    const adapter = ready(chatWith([{ id: { _serialized: 'true_628@c.us_RAW1', id: 'RAW1' }, edit }]));
    const res = await adapter.editMessage('628@c.us', 'RAW1', 'new body');
    expect(edit).toHaveBeenCalledWith('new body');
    expect(res.id).toBe('true_628@c.us_RAW1');
  });

  it('throws MessageNotFoundError when the message is outside the fetch window', async () => {
    const adapter = ready(chatWith([]));
    await expect(adapter.editMessage('628@c.us', 'GONE', 'x')).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it('propagates an engine edit failure unchanged', async () => {
    const edit = jest.fn().mockRejectedValue(new Error('Evaluation failed'));
    const adapter = ready(chatWith([{ id: { _serialized: 'M1' }, edit }]));
    await expect(adapter.editMessage('628@c.us', 'M1', 'x')).rejects.toThrow('Evaluation failed');
  });

  it('throws MessageNotFoundError when the chat id itself is unknown (getChatById resolves undefined)', async () => {
    const adapter = ready({ getChatById: jest.fn().mockResolvedValue(undefined) });
    await expect(adapter.editMessage('nobody@c.us', 'M1', 'x')).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it('treats a null edit result as a refusal (EngineRefusedError, 403), not a phantom success', async () => {
    const edit = jest.fn().mockResolvedValue(null);
    const adapter = ready(chatWith([{ id: { _serialized: 'M1' }, edit }]));
    const err = await adapter.editMessage('628@c.us', 'M1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRefusedError);
    expect((err as Error).message).toMatch(/was rejected/);
  });
});

describe('LID mapping persistence to LidMappingStore (#583 R3)', () => {
  const readyWithStore = (client: unknown, lidMappingStore: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 's1',
      sessionDataPath: './data/sessions',
      puppeteer: {},
      lidMappingStore: lidMappingStore as never,
    });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const sentMessage = { id: { _serialized: 'OUT1' }, timestamp: 1700000001 };
  const makeStore = (remember: jest.Mock) => ({ remember, getCached: () => undefined, lidsForPhone: () => [] });

  it('persists phone->lid (bare digits) when a contact resolves to an @lid', async () => {
    const remember = jest.fn().mockResolvedValue(undefined);
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await readyWithStore({ getNumberId, sendMessage }, makeStore(remember)).sendTextMessage('529934031058@c.us', 'hi');
    expect(remember).toHaveBeenCalledWith('159442138038327', '529934031058', 's1');
  });

  it('does not persist a confirmed non-migrated (@c.us) resolution', async () => {
    const remember = jest.fn().mockResolvedValue(undefined);
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '628@c.us' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await readyWithStore({ getNumberId, sendMessage }, makeStore(remember)).sendTextMessage('628@c.us', 'hi');
    expect(remember).not.toHaveBeenCalled();
  });

  it('a rejecting remember never fails the send (fire-and-forget)', async () => {
    const remember = jest.fn().mockRejectedValue(new Error('db down'));
    const getNumberId = jest.fn().mockResolvedValue({ _serialized: '159442138038327@lid' });
    const sendMessage = jest.fn().mockResolvedValue(sentMessage);
    await expect(
      readyWithStore({ getNumberId, sendMessage }, makeStore(remember)).sendTextMessage('529934031058@c.us', 'hi'),
    ).resolves.toBeDefined();
  });
});

describe('extractWwebjsCall (call_log → { video, missed }, salvaged from #494)', () => {
  const m = (over: Record<string, unknown>) => over as unknown as Parameters<typeof extractWwebjsCall>[0];

  it('returns undefined for a non-call message', () => {
    expect(extractWwebjsCall(m({ type: 'chat' }))).toBeUndefined();
  });

  it('flags a video call with a recorded duration as not-missed', () => {
    expect(
      extractWwebjsCall(m({ type: 'call_log', fromMe: false, _data: { isVideoCall: true, callDuration: 30 } })),
    ).toEqual({
      video: true,
      missed: false,
    });
  });

  it('marks an unanswered incoming voice call (no duration) as missed', () => {
    expect(extractWwebjsCall(m({ type: 'call_log', fromMe: false, _data: {} }))).toEqual({
      video: false,
      missed: true,
    });
  });

  it('never marks an outgoing call as missed', () => {
    expect(extractWwebjsCall(m({ type: 'call_log', fromMe: true, _data: {} }))).toEqual({
      video: false,
      missed: false,
    });
  });
});

describe('WhatsAppWebJsAdapter inbound media concurrency (slot held until the real download settles)', () => {
  const ENV_KEYS = [
    'INBOUND_MEDIA_CONCURRENCY',
    'MEDIA_DOWNLOAD_TIMEOUT_MS',
    'MEDIA_DOWNLOAD_MAX_BYTES',
    'MEDIA_DOWNLOAD_ENABLED',
  ];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    ENV_KEYS.forEach(k => (saved[k] = process.env[k]));
  });
  afterEach(() => {
    ENV_KEYS.forEach(k => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    jest.useRealTimers();
  });

  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
  const defer = <T>(): Deferred<T> => {
    let resolve: (v: T) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'media-1', sessionDataPath: './data/sessions', puppeteer: {} });

  it('does not start a second download until the first real download settles, even after the caller times out', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '20';
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = String(10 * 1024 * 1024);
    process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
    jest.useFakeTimers();

    const adapter = newAdapter();
    let inFlight = 0;
    let maxInFlight = 0;
    const downloads: Deferred<{ mimetype: string; data: string }>[] = [];
    const makeMsg = (id: string): unknown => ({
      id: { _serialized: id },
      _data: { size: 100, mimetype: 'image/png' },
      downloadMedia: jest.fn(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const d = defer<{ mimetype: string; data: string }>();
        downloads.push(d);
        return d.promise.finally(() => {
          inFlight--;
        });
      }),
    });
    const cap = (m: unknown): Promise<unknown> =>
      (adapter as unknown as { capInboundMediaFor: (msg: unknown) => Promise<unknown> }).capInboundMediaFor(m);

    const r1 = cap(makeMsg('m1')); // download1 starts synchronously (slot 1)
    const r2 = cap(makeMsg('m2')); // parks on the limiter; download2 must NOT start
    expect(downloads.length).toBe(1);

    // Time out BOTH callers' wall-clock deadline while the real download is still pending. With the old
    // coupling this freed the slot and admitted download2 (inFlight 2); the fix holds the slot.
    await jest.advanceTimersByTimeAsync(25);
    expect(await r1).toEqual(expect.objectContaining({ mimetype: 'image/png', omitted: true, sizeBytes: 100 }));
    expect(downloads.length).toBe(1); // download2 still not started — slot held by the pending real download1
    expect(maxInFlight).toBe(1);

    // The real download1 finally settles -> the slot transfers and download2 may now start.
    downloads[0].resolve({ mimetype: 'image/png', data: Buffer.from('a').toString('base64') });
    await jest.advanceTimersByTimeAsync(0);
    expect(downloads.length).toBe(2);
    expect(maxInFlight).toBe(1);

    // Settle the rest so nothing dangles.
    await jest.advanceTimersByTimeAsync(25);
    expect(await r2).toEqual(expect.objectContaining({ mimetype: 'image/png', omitted: true, sizeBytes: 100 }));
    downloads[1].resolve({ mimetype: 'image/png', data: Buffer.from('b').toString('base64') });
    await jest.advanceTimersByTimeAsync(0);
    expect(maxInFlight).toBe(1);
  });

  it('propagates a rejecting download to the caller and releases the slot for the next download', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '10000'; // long: we want the reject, not the timeout
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = String(10 * 1024 * 1024);
    process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
    jest.useFakeTimers();

    const adapter = newAdapter();
    const calls: string[] = [];
    const makeMsg = (id: string, behavior: 'reject' | 'resolve'): unknown => ({
      id: { _serialized: id },
      _data: { size: 100, mimetype: 'image/png' },
      downloadMedia: jest.fn(() => {
        calls.push(id);
        return behavior === 'reject'
          ? Promise.reject(new Error('download blew up'))
          : Promise.resolve({ mimetype: 'image/png', data: Buffer.from('ok').toString('base64') });
      }),
    });
    const cap = (m: unknown): Promise<unknown> =>
      (adapter as unknown as { capInboundMediaFor: (msg: unknown) => Promise<unknown> }).capInboundMediaFor(m);

    await expect(cap(makeMsg('bad', 'reject'))).rejects.toThrow('download blew up');
    // Slot must have been released despite the rejection — the next download proceeds and resolves.
    const media = (await cap(makeMsg('good', 'resolve'))) as { mimetype: string; data: string };
    expect(media.data).toBe(Buffer.from('ok').toString('base64'));
    expect(calls).toEqual(['bad', 'good']);
  });
});

/**
 * The send contract when whatsapp-web.js cannot hand back a usable message (#757).
 *
 * `Client.sendMessage` RESOLVES with `undefined` rather than throwing, collapsing two opposite outcomes
 * into one value (`Client.js:1558`), and its typings claim `Promise<Message>` — so nothing upstream of
 * these tests catches a regression here.
 */
describe('WhatsAppWebJsAdapter send-result contract', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('reports a send as failed when the engine resolves without a message', async () => {
    // The dangerous case: `undefined` means EITHER the chat never resolved and nothing was sent, OR the
    // message went out and only its id was unreadable. Indistinguishable here — so this must not be
    // reported as success. A false negative is retryable; a 201 for a message that never left is not.
    const sendMessage = jest.fn().mockResolvedValue(undefined);

    await expect(readyAdapter({ sendMessage }).sendTextMessage('621@c.us', 'hi')).rejects.toThrow(
      /may not have been delivered/,
    );
    // Regression guard: the old code dereferenced `msg.id` and surfaced an opaque TypeError instead.
    await expect(readyAdapter({ sendMessage }).sendTextMessage('621@c.us', 'hi')).rejects.not.toThrow(TypeError);
  });

  it('returns the empty no-id sentinel when the message exists but its id is unreadable', async () => {
    // A Message instance proves the send happened, so an unreadable id is unambiguously "sent, id
    // unknown" — the shape a future WhatsApp Web re-mangle of `$1` would produce. Never fabricate one.
    const sendMessage = jest.fn().mockResolvedValue({ id: { someFutureName: 'x' }, timestamp: 1700000000 });

    const res = await readyAdapter({ sendMessage }).sendTextMessage('621@c.us', 'hi');

    expect(res).toEqual({ id: '', timestamp: 1700000000 });
  });

  it('reads a renamed $1 id when the dependency has not normalized it', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ id: { $1: 'true_621@c.us_ABC' }, timestamp: 1700000001 });

    const res = await readyAdapter({ sendMessage }).sendTextMessage('621@c.us', 'hi');

    expect(res).toEqual({ id: 'true_621@c.us_ABC', timestamp: 1700000001 });
  });

  it('passes a healthy id straight through', async () => {
    const sendMessage = jest
      .fn()
      .mockResolvedValue({ id: { _serialized: 'true_621@c.us_XYZ' }, timestamp: 1700000002 });

    const res = await readyAdapter({ sendMessage }).sendTextMessage('621@c.us', 'hi');

    expect(res).toEqual({ id: 'true_621@c.us_XYZ', timestamp: 1700000002 });
  });
});

describe('WhatsAppWebJsAdapter message_ack (unreadable id)', () => {
  const wireAckHandler = (): { onMessageAck: jest.Mock; client: EventEmitter } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-ack-test',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { _serialized: 'me@c.us', user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessageAck = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessageAck };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
    return { onMessageAck, client };
  };

  it('forwards the ack on a healthy build', () => {
    const { onMessageAck, client } = wireAckHandler();

    client.emit('message_ack', { id: { _serialized: 'ACKED_MSG' } }, 3);

    expect(onMessageAck).toHaveBeenCalledWith('ACKED_MSG', expect.any(String));
  });

  it('reads a renamed `$1` id when the dependency has not normalized it', () => {
    // The send path recovers from the rename; the ack path must too, or a message sent on an unpatched
    // build can never leave SENT — including via `ack < 0`, the one signal that it failed outright.
    const { onMessageAck, client } = wireAckHandler();

    client.emit('message_ack', { id: { $1: 'ACKED_RENAMED' } }, 3);

    expect(onMessageAck).toHaveBeenCalledWith('ACKED_RENAMED', expect.any(String));
  });

  it('drops an ack whose id cannot be read instead of passing undefined on', () => {
    // An undefined id reaches the ack UPDATE as `waMessageId = NULL`, which matches nothing (`x = NULL`
    // is never true in SQL). The ack would advance no row and still burn its one-shot retry, leaving the
    // message at SENT with only a misleading "no status row advanced" in the log.
    const { onMessageAck, client } = wireAckHandler();

    client.emit('message_ack', { id: { someFutureName: 'x' } }, 3);

    expect(onMessageAck).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebJsAdapter createGroup (failure shapes)', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it("surfaces the engine's reason when creation fails", async () => {
    // whatsapp-web.js RESOLVES with a plain string on failure rather than throwing (Client.js:2376).
    // Reading `.gid` off it produced an opaque TypeError and threw the actual reason away.
    const createGroup = jest
      .fn()
      .mockResolvedValue('CreateGroupError: An unknown error occupied while creating a group');

    await expect(readyAdapter({ createGroup }).createGroup('team', ['628123@c.us'])).rejects.toThrow(
      /CreateGroupError/,
    );
  });

  it('never returns a placeholder when the group id cannot be read', async () => {
    // The old `String(gid._serialized)` coerced an unreadable id into the literal string "undefined"
    // and handed it back as a real, addressable group id.
    const createGroup = jest.fn().mockResolvedValue({ gid: { someFutureName: 'x' } });

    const call = readyAdapter({ createGroup }).createGroup('team', ['628123@c.us']);

    await expect(call).rejects.toThrow(/id could not be read/);
    await expect(call).rejects.not.toThrow(/undefined/);
  });

  it('returns the group on success', async () => {
    const createGroup = jest.fn().mockResolvedValue({ gid: { _serialized: '120363000@g.us' } });

    const res = await readyAdapter({ createGroup }).createGroup('team', ['628123@c.us', '628124@c.us']);

    expect(res).toEqual({ id: '120363000@g.us', name: 'team', participantsCount: 2 });
  });
});

describe('WhatsAppWebJsAdapter puppeteer death detection (browser/page silent death)', () => {
  type PuppeteerFakeClient = EventEmitter & {
    getState: jest.Mock;
    pupBrowser: EventEmitter;
    pupPage: EventEmitter;
    destroy?: jest.Mock;
  };

  const wireAdapter = (
    overrides: { status?: EngineStatus; tearingDown?: boolean; client?: Partial<PuppeteerFakeClient> } = {},
  ): { adapter: WhatsAppWebJsAdapter; client: PuppeteerFakeClient; onDisconnected: jest.Mock } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-pup-death',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = Object.assign(new EventEmitter(), {
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupBrowser: new EventEmitter(),
      pupPage: new EventEmitter(),
      ...overrides.client,
    }) as PuppeteerFakeClient;
    const onDisconnected = jest.fn();
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = { onDisconnected };
    (adapter as unknown as { status: EngineStatus }).status = overrides.status ?? EngineStatus.READY;
    (adapter as unknown as { tearingDown: boolean }).tearingDown = overrides.tearingDown ?? false;
    (adapter as unknown as { attachPuppeteerLifecycleListeners: () => void }).attachPuppeteerLifecycleListeners();
    return { adapter, client, onDisconnected };
  };

  it('reports the browser process closing or crashing as a disconnect', () => {
    const { adapter, client, onDisconnected } = wireAdapter();

    client.pupBrowser.emit('disconnected');

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith('Browser process closed or crashed');
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('reports a renderer crash (page error) as a disconnect', () => {
    const { adapter, client, onDisconnected } = wireAdapter();

    client.pupPage.emit('error', new Error('Page crashed!'));

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith('Page crashed');
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('reports the page being closed as a disconnect', () => {
    const { adapter, client, onDisconnected } = wireAdapter();

    client.pupPage.emit('close');

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith('Page closed');
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('does not double-report when page error and browser disconnected fire together', () => {
    const { client, onDisconnected } = wireAdapter();

    client.pupPage.emit('error', new Error('Page crashed!'));
    client.pupBrowser.emit('disconnected');
    client.pupPage.emit('close');

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith('Page crashed');
  });

  it.each([
    ['pupBrowser', 'disconnected'],
    ['pupPage', 'error'],
    ['pupPage', 'close'],
  ] as const)('ignores %s %s during an intentional teardown', (handle, event) => {
    const { client, onDisconnected } = wireAdapter({ tearingDown: true });

    client[handle].emit(event, new Error('boom'));

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('ignores the death events once the status is already DISCONNECTED', () => {
    const { client, onDisconnected } = wireAdapter({ status: EngineStatus.DISCONNECTED });

    client.pupBrowser.emit('disconnected');
    client.pupPage.emit('error', new Error('boom'));
    client.pupPage.emit('close');

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('ignores the browser disconnected event raised by a deliberate disconnect()', async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    const { adapter, client, onDisconnected } = wireAdapter({ client: { destroy } });

    await adapter.disconnect(); // sets tearingDown + DISCONNECTED, then destroys the client
    client.pupBrowser.emit('disconnected');

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebJsAdapter.probeLiveness (session watchdog probe)', () => {
  const adapterWith = (client: unknown, status: EngineStatus = EngineStatus.READY): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = status;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('resolves true when getState() reports CONNECTED', async () => {
    const adapter = adapterWith({ getState: jest.fn().mockResolvedValue(WAState.CONNECTED) });

    await expect(adapter.probeLiveness()).resolves.toBe(true);
  });

  it('resolves false when getState() rejects (page already gone)', async () => {
    const adapter = adapterWith({ getState: jest.fn().mockRejectedValue(new Error('Target closed')) });

    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('resolves false when getState() reports a non-CONNECTED state', async () => {
    const adapter = adapterWith({ getState: jest.fn().mockResolvedValue(WAState.OPENING) });

    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('resolves false without touching the client when the adapter is not READY', async () => {
    const getState = jest.fn();
    const adapter = adapterWith({ getState }, EngineStatus.AUTHENTICATING);

    await expect(adapter.probeLiveness()).resolves.toBe(false);
    expect(getState).not.toHaveBeenCalled();
  });

  it('resolves false when there is no client', async () => {
    await expect(adapterWith(null).probeLiveness()).resolves.toBe(false);
  });

  it('resolves false when getState() hangs past the 10s timeout, leaving no dangling timer', async () => {
    jest.useFakeTimers();
    try {
      const adapter = adapterWith({ getState: jest.fn().mockReturnValue(new Promise<never>(() => {})) });

      const probe = adapter.probeLiveness();
      const assertion = expect(probe).resolves.toBe(false);
      await jest.advanceTimersByTimeAsync(10_000);

      await assertion;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('WhatsAppWebJsAdapter stale Singleton cleanup (pre-launch)', () => {
  const SESSION_ID = 'sess-singleton';
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: SESSION_ID, sessionDataPath: './data/sessions', puppeteer: {} });

  let rmSpy: jest.SpyInstance;
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  beforeEach(() => {
    // Keep initialize() offline: 'off' skips the wa-version registry fetch in resolveWebVersionPin.
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    // Stub Client.prototype.initialize so the real wwebjs Client is built but no browser launches.
    // (Structural cast: the wwebjs Client typings don't resolve under the lint project.)
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSpy.mockRestore();
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('removes the three Singleton files from the LocalAuth profile dir right before client.initialize()', async () => {
    const order: string[] = [];
    rmSpy.mockImplementation(() => {
      order.push('rm');
      return Promise.resolve(undefined);
    });
    clientInitSpy.mockImplementation(() => {
      order.push('client.initialize');
      return Promise.resolve(undefined);
    });

    await newAdapter().initialize({});

    // Same dir LocalAuth uses as userDataDir: <resolved dataPath>/session-<clientId>.
    const profileDir = path.join(path.resolve('./data/sessions'), `session-${SESSION_ID}`);
    expect(rmSpy).toHaveBeenCalledTimes(3);
    expect(rmSpy).toHaveBeenCalledWith(path.join(profileDir, 'SingletonLock'), { force: true });
    expect(rmSpy).toHaveBeenCalledWith(path.join(profileDir, 'SingletonSocket'), { force: true });
    expect(rmSpy).toHaveBeenCalledWith(path.join(profileDir, 'SingletonCookie'), { force: true });
    expect(clientInitSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['rm', 'rm', 'rm', 'client.initialize']);
  });

  it('still initializes when the Singleton files cannot be removed (best-effort, never fails the start)', async () => {
    rmSpy.mockRejectedValue(new Error('EPERM: operation not permitted'));

    await expect(newAdapter().initialize({})).resolves.toBeUndefined();

    expect(rmSpy).toHaveBeenCalledTimes(3); // all three attempted even though each failed
    expect(clientInitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsAppWebJsAdapter orphaned Chromium sweep (pre-launch)', () => {
  const SESSION_ID = 'sess-orphan';
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: SESSION_ID, sessionDataPath: './data/sessions', puppeteer: {} });

  type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

  let execFileSpy: jest.SpyInstance;
  let killSpy: jest.SpyInstance;
  let rmSpy: jest.SpyInstance;
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  // execFile is overloaded, so spy through a structural shape like the Client.prototype spies above.
  // The adapter invokes it as execFile('ps', args, opts, callback); the callback is always last.
  const mockPsResult = (result: { stdout?: string; error?: Error }): void => {
    execFileSpy.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCallback;
      cb(result.error ?? null, result.stdout ?? '', '');
    });
  };
  // `ps -eo pid=,args=` rows: leading whitespace, pid, then the full command line.
  const psTable = (rows: [number, string][]): string => rows.map(([pid, args]) => `  ${pid} ${args}`).join('\n') + '\n';
  const loggerLogSpy = (adapter: WhatsAppWebJsAdapter): jest.SpyInstance => {
    const logger = (adapter as unknown as { logger: { log: (message: string, context?: unknown) => void } }).logger;
    return jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  };

  beforeEach(() => {
    // Keep initialize() offline: 'off' skips the wa-version registry fetch in resolveWebVersionPin.
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    // Default: an empty process table (nothing to sweep); tests override via mockPsResult.
    execFileSpy = jest
      .spyOn(childProcess as unknown as { execFile: (...args: unknown[]) => void }, 'execFile')
      .mockImplementation((...args: unknown[]) => {
        (args[args.length - 1] as ExecFileCallback)(null, '', '');
      });
    // Never let a test signal a real process.
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    // Stub Client.prototype.initialize so the real wwebjs Client is built but no browser launches.
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    execFileSpy.mockRestore();
    killSpy.mockRestore();
    rmSpy.mockRestore();
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('appends the --openwa-session marker to the puppeteer args handed to the Client', async () => {
    const adapter = newAdapter();

    await adapter.initialize({});

    const client = (adapter as unknown as { client: { options: { puppeteer?: { args?: string[] } } } }).client;
    expect(client.options.puppeteer?.args).toContain(`--openwa-session=${SESSION_ID}`);
  });

  it('does not mutate the caller-owned puppeteer args array shared across sessions', async () => {
    // Every adapter receives the SAME array instance — ConfigService.get() returns a live reference
    // into the cached config tree, via the plugin path (plugins/engines/whatsapp-web-js) and the
    // factory fallback alike. Appending in place therefore rewrites global config for the rest of
    // the process lifetime, leaking one session's flags (proxy, session marker) into every later
    // launch. Without the defensive copy this assertion sees both session markers accumulate.
    const sharedArgs = ['--no-sandbox'];
    const argsFor = async (sessionId: string): Promise<string[] | undefined> => {
      const adapter = new WhatsAppWebJsAdapter({
        sessionId,
        sessionDataPath: './data/sessions',
        puppeteer: { args: sharedArgs },
      });
      await adapter.initialize({});
      return (adapter as unknown as { client: { options: { puppeteer?: { args?: string[] } } } }).client.options
        .puppeteer?.args;
    };

    await argsFor('sess-a');
    const argsB = await argsFor('sess-b');

    expect(sharedArgs).toEqual(['--no-sandbox']);
    expect(argsB).toContain('--openwa-session=sess-b');
    // The cross-session leak that let a restart of sess-a SIGKILL sess-b's live browser: the sweep
    // substring-matches this marker against the full `ps` command line.
    expect(argsB).not.toContain('--openwa-session=sess-a');
  });

  it('SIGKILLs a Chromium process carrying this session marker and logs the sweep', async () => {
    mockPsResult({
      stdout: psTable([
        [
          1501,
          `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --openwa-session=${SESSION_ID}`,
        ],
        [1502, '/usr/bin/node dist/main.js'],
      ]),
    });
    const adapter = newAdapter();
    const logSpy = loggerLogSpy(adapter);

    await adapter.initialize({});

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    // No shell: ps is exec'd directly with an argv array, an options object, and a callback.
    expect(execFileSpy).toHaveBeenCalledWith('ps', ['-eo', 'pid=,args='], expect.any(Object), expect.any(Function));
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(1501, 'SIGKILL');
    expect(logSpy).toHaveBeenCalledWith(
      'Killed 1 orphaned Chromium process(es) left over from a previous process lifetime',
      {
        sessionId: SESSION_ID,
        pids: [1501],
      },
    );
  });

  it('does NOT kill a non-browser process that merely carries the marker string', async () => {
    mockPsResult({
      stdout: psTable([
        [1601, `/bin/grep --openwa-session=${SESSION_ID}`],
        [1602, `/usr/bin/node scan-sessions.js --openwa-session=${SESSION_ID}`],
      ]),
    });

    await newAdapter().initialize({});

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does NOT kill a Chromium process belonging to a different session', async () => {
    mockPsResult({
      stdout: psTable([[1701, '/usr/lib/chromium/chromium --headless --no-sandbox --openwa-session=session-lain']]),
    });

    await newAdapter().initialize({});

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('skips the sweep on platforms other than darwin/linux (no ps, no kill)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await newAdapter().initialize({});
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    expect(execFileSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('still initializes when ps fails (best-effort, never fails the start)', async () => {
    mockPsResult({ error: new Error('spawn ps ENOENT') });

    await expect(newAdapter().initialize({})).resolves.toBeUndefined();

    expect(killSpy).not.toHaveBeenCalled();
    expect(clientInitSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the orphan sweep before the Singleton cleanup and client.initialize()', async () => {
    const order: string[] = [];
    execFileSpy.mockImplementation((...args: unknown[]) => {
      order.push('ps');
      (args[args.length - 1] as ExecFileCallback)(
        null,
        psTable([[1801, `/usr/bin/chromium --headless --openwa-session=${SESSION_ID}`]]),
        '',
      );
    });
    killSpy.mockImplementation(() => {
      order.push('kill');
      return true;
    });
    rmSpy.mockImplementation(() => {
      order.push('rm');
      return Promise.resolve(undefined);
    });
    clientInitSpy.mockImplementation(() => {
      order.push('client.initialize');
      return Promise.resolve(undefined);
    });

    await newAdapter().initialize({});

    expect(order).toEqual(['ps', 'kill', 'rm', 'rm', 'rm', 'client.initialize']);
  });
});

describe('WhatsAppWebJsAdapter page transport error detection (wedged page fast-path, wwebjs #5728)', () => {
  const readyAdapter = (client: unknown): { adapter: WhatsAppWebJsAdapter; onDisconnected: jest.Mock } => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    const onDisconnected = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onDisconnected };
    return { adapter, onDisconnected };
  };

  // A wedged page fires no events while still reporting CONNECTED, so a failed operation carrying a
  // transport-death signature is the earliest signal — it must route through the disconnect path.
  it.each([
    'Protocol error: Target closed',
    'Protocol error (Runtime.callFunctionOn): Target closed.',
    'TargetClosedError: page closed',
    'Attempted to use detached Frame',
    'Session closed',
    'Connection closed',
  ])('reports a failed send carrying "%s" as a disconnect', async message => {
    const sendMessage = jest.fn().mockRejectedValue(new Error(message));
    const { adapter, onDisconnected } = readyAdapter({ sendMessage });

    await expect(adapter.sendTextMessage('628111@c.us', 'hi')).rejects.toThrow(message);

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith('Page transport error during sendMessage');
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  // Ordinary operation failures must NOT trip the death path — the error only propagates to the caller.
  it.each(['WhatsApp rate limit', 'Evaluation failed: TypeError: x is not a function'])(
    'does not report an ordinary send failure (%s) as a disconnect',
    async message => {
      const sendMessage = jest.fn().mockRejectedValue(new Error(message));
      const { adapter, onDisconnected } = readyAdapter({ sendMessage });

      await expect(adapter.sendTextMessage('628111@c.us', 'hi')).rejects.toThrow(message);

      expect(onDisconnected).not.toHaveBeenCalled();
      expect(adapter.getStatus()).toBe(EngineStatus.READY);
    },
  );

  it('detects a transport error from a getter too (getContacts)', async () => {
    const getContacts = jest.fn().mockRejectedValue(new Error('Protocol error: Target closed'));
    const { adapter, onDisconnected } = readyAdapter({ getContacts });

    await expect(adapter.getContacts()).rejects.toThrow('Protocol error: Target closed');

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith('Page transport error during getContacts');
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('reports nothing when the failure happens during an intentional teardown', async () => {
    const sendMessage = jest.fn().mockRejectedValue(new Error('Protocol error: Target closed'));
    const { adapter, onDisconnected } = readyAdapter({ sendMessage });
    (adapter as unknown as { tearingDown: boolean }).tearingDown = true;

    await expect(adapter.sendTextMessage('628111@c.us', 'hi')).rejects.toThrow('Protocol error: Target closed');

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
  });
});

describe('WhatsAppWebJsAdapter group join + settings + own profile', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  describe('joinGroupViaInviteCode', () => {
    it('returns the joined group id from acceptInvite', async () => {
      const acceptInvite = jest.fn().mockResolvedValue('120363000@g.us');
      await expect(readyAdapter({ acceptInvite }).joinGroupViaInviteCode('CODE123')).resolves.toBe('120363000@g.us');
      expect(acceptInvite).toHaveBeenCalledWith('CODE123');
    });

    it('maps a thrown page error to InvalidInviteCodeError (400)', async () => {
      const acceptInvite = jest.fn().mockRejectedValue(new Error('Evaluation failed: invite revoked'));
      await expect(readyAdapter({ acceptInvite }).joinGroupViaInviteCode('BAD')).rejects.toBeInstanceOf(
        InvalidInviteCodeError,
      );
    });

    it('maps a gid-less result to InvalidInviteCodeError (400)', async () => {
      const acceptInvite = jest.fn().mockResolvedValue(undefined);
      await expect(readyAdapter({ acceptInvite }).joinGroupViaInviteCode('BAD')).rejects.toBeInstanceOf(
        InvalidInviteCodeError,
      );
    });
  });

  describe('setGroupMessagesAdminsOnly / setGroupInfoAdminsOnly', () => {
    const groupClient = (impl: Record<string, jest.Mock>) => ({
      getChatById: jest.fn().mockResolvedValue({ isGroup: true, ...impl }),
    });

    it('resolves the group chat and calls setMessagesAdminsOnly', async () => {
      const setMessagesAdminsOnly = jest.fn().mockResolvedValue(true);
      await readyAdapter(groupClient({ setMessagesAdminsOnly })).setGroupMessagesAdminsOnly('g@g.us', true);
      expect(setMessagesAdminsOnly).toHaveBeenCalledWith(true);
    });

    it('resolves the group chat and calls setInfoAdminsOnly', async () => {
      const setInfoAdminsOnly = jest.fn().mockResolvedValue(true);
      await readyAdapter(groupClient({ setInfoAdminsOnly })).setGroupInfoAdminsOnly('g@g.us', false);
      expect(setInfoAdminsOnly).toHaveBeenCalledWith(false);
    });

    it('throws GroupNotFoundError (404) when the chat is not a group', async () => {
      const getChatById = jest.fn().mockResolvedValue({ isGroup: false });
      await expect(
        readyAdapter({ getChatById }).setGroupMessagesAdminsOnly('628111@c.us', true),
      ).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('throws GroupNotFoundError (404) when the chat id is unknown (getChatById resolves undefined)', async () => {
      const getChatById = jest.fn().mockResolvedValue(undefined);
      await expect(readyAdapter({ getChatById }).setGroupMessagesAdminsOnly('gone@g.us', true)).rejects.toBeInstanceOf(
        GroupNotFoundError,
      );
    });

    it.each([
      ['setGroupMessagesAdminsOnly', 'setMessagesAdminsOnly'],
      ['setGroupInfoAdminsOnly', 'setInfoAdminsOnly'],
    ])('%s throws EngineRefusedError (403) when the engine reports false (no admin rights)', async (method, native) => {
      // wwebjs RESOLVES false (instead of throwing) on a ServerStatusCodeError — a silent no-op
      // would dress up a refused write as a success.
      const client = groupClient({ [native]: jest.fn().mockResolvedValue(false) });
      const call = (readyAdapter(client) as unknown as Record<string, (g: string, v: boolean) => Promise<void>>)[
        method
      ]('g@g.us', true);
      const err = await call.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EngineRefusedError);
      expect((err as Error).message).toMatch(/admin rights required/);
    });
  });

  describe('setGroupEphemeral (no wwjs 1.34.7 API → honest 501)', () => {
    it('rejects with EngineNotSupportedError (501)', async () => {
      const err = await readyAdapter({})
        .setGroupEphemeral('g@g.us', 86400)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EngineNotSupportedError);
      expect((err as EngineNotSupportedError).getStatus()).toBe(501);
    });
  });

  describe('setProfileName / setProfileStatus', () => {
    it('setProfileName resolves when the engine accepts', async () => {
      const setDisplayName = jest.fn().mockResolvedValue(true);
      await expect(readyAdapter({ setDisplayName }).setProfileName('New Name')).resolves.toBeUndefined();
      expect(setDisplayName).toHaveBeenCalledWith('New Name');
    });

    it('setProfileName throws EngineRefusedError (403) when the engine resolves false', async () => {
      const setDisplayName = jest.fn().mockResolvedValue(false);
      const err = await readyAdapter({ setDisplayName })
        .setProfileName('New Name')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EngineRefusedError);
      expect((err as Error).message).toMatch(/rejected the profile name change/);
    });

    it('setProfileStatus delegates to client.setStatus', async () => {
      const setStatus = jest.fn().mockResolvedValue(undefined);
      await readyAdapter({ setStatus }).setProfileStatus('busy');
      expect(setStatus).toHaveBeenCalledWith('busy');
    });
  });

  describe('setProfilePicture', () => {
    it('converts base64 MediaInput to a MessageMedia (same helper as media sends)', async () => {
      const setProfilePicture = jest.fn().mockResolvedValue(true);
      await readyAdapter({ setProfilePicture }).setProfilePicture({
        mimetype: 'image/png',
        data: Buffer.from([1, 2, 3]).toString('base64'),
      });
      const calls = setProfilePicture.mock.calls as Array<[MessageMedia]>;
      const media = calls[0][0];
      expect(media).toBeInstanceOf(MessageMedia);
      expect(media.mimetype).toBe('image/png');
      expect(media.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    });

    it('converts a Buffer payload to base64 MessageMedia', async () => {
      const setProfilePicture = jest.fn().mockResolvedValue(true);
      await readyAdapter({ setProfilePicture }).setProfilePicture({ mimetype: 'image/jpeg', data: Buffer.from('IMG') });
      const calls = setProfilePicture.mock.calls as Array<[MessageMedia]>;
      expect(calls[0][0].data).toBe(Buffer.from('IMG').toString('base64'));
    });

    it('throws EngineRefusedError (403) when the engine resolves false', async () => {
      const setProfilePicture = jest.fn().mockResolvedValue(false);
      const err = await readyAdapter({ setProfilePicture })
        .setProfilePicture({ mimetype: 'image/jpeg', data: 'AAAA' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EngineRefusedError);
      expect((err as Error).message).toMatch(/rejected the profile picture change/);
    });
  });

  describe('getGroupInfo settings fields', () => {
    it('populates announce/locked/ephemeralSeconds from the native groupMetadata', async () => {
      const getChatById = jest.fn().mockResolvedValue({
        isGroup: true,
        id: { _serialized: '120363000@g.us' },
        name: 'G',
        participants: [],
        groupMetadata: { announce: true, restrict: true, ephemeralDuration: 604800 },
      });
      const info = await readyAdapter({ getChatById }).getGroupInfo('120363000@g.us');
      expect(info?.announce).toBe(true);
      expect(info?.locked).toBe(true);
      expect(info?.ephemeralSeconds).toBe(604800);
    });

    it('leaves the settings fields undefined when the metadata does not carry them', async () => {
      const getChatById = jest.fn().mockResolvedValue({
        isGroup: true,
        id: { _serialized: '120363000@g.us' },
        name: 'G',
        participants: [],
        groupMetadata: {},
      });
      const info = await readyAdapter({ getChatById }).getGroupInfo('120363000@g.us');
      expect(info?.announce).toBeUndefined();
      expect(info?.locked).toBeUndefined();
      expect(info?.ephemeralSeconds).toBeUndefined();
    });
  });
});
