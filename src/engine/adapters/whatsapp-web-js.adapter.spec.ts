import { MessageMedia, WAState } from 'whatsapp-web.js';
import { EventEmitter } from 'events';
import {
  WhatsAppWebJsAdapter,
  extractLinkedParentJID,
  isHttpUrl,
  isSupportedProxyUrl,
  loadRemoteMedia,
  resolveAuthTimeoutMs,
  wwebjsAckToDeliveryStatus,
  extractWwebjsCall,
} from './whatsapp-web-js.adapter';
import { getEffectiveWebVersionInfo, resolveWebVersionPin, __resetWebVersionCache } from '../wa-web-version';
import * as fs from 'fs';
import * as qrcode from 'qrcode';
import { UnprocessableEntityException } from '@nestjs/common';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
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

  it('is a no-op when there is no client', async () => {
    const adapter = newAdapter();
    await expect(adapter.forceDestroy()).resolves.toBeUndefined();
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

describe('WhatsAppWebJsAdapter status methods (Baileys-only, surface HTTP 501, #455)', () => {
  // The 4 status methods are Baileys-only; the wwebjs adapter stubs each to EngineNotSupportedError
  // (which extends NestJS NotImplementedException -> HTTP 501). This locks the new-contract signatures
  // (postTextStatus(text, options) / postImage|VideoStatus(media, options) / deleteStatus(statusId))
  // so a future refactor that silently starts returning data instead of throwing is caught here.
  const readyAdapter = (): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    // ensureReady() requires both status === READY and a non-null client before the method body runs.
    (adapter as unknown as { client: unknown }).client = {};
    return adapter;
  };
  const media = { mimetype: 'image/png', data: 'iVBOR' };
  const options = { recipients: ['628111@c.us'] };

  it.each([
    ['postTextStatus', ['hello', options]] as const,
    ['postImageStatus', [media, options]] as const,
    ['postVideoStatus', [media, options]] as const,
    ['deleteStatus', ['STATUS1']] as const,
  ])('%s rejects with EngineNotSupportedError (501)', async (method, args) => {
    await expect(
      (readyAdapter() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...args),
    ).rejects.toBeInstanceOf(EngineNotSupportedError);
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
    expect(await r1).toBeUndefined(); // caller unblocked on the timeout race
    expect(downloads.length).toBe(1); // download2 still not started — slot held by the pending real download1
    expect(maxInFlight).toBe(1);

    // The real download1 finally settles -> the slot transfers and download2 may now start.
    downloads[0].resolve({ mimetype: 'image/png', data: Buffer.from('a').toString('base64') });
    await jest.advanceTimersByTimeAsync(0);
    expect(downloads.length).toBe(2);
    expect(maxInFlight).toBe(1);

    // Settle the rest so nothing dangles.
    await jest.advanceTimersByTimeAsync(25);
    expect(await r2).toBeUndefined();
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
