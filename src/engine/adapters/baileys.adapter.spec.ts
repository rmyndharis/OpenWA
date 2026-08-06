import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../common/media/load-remote-media', () => ({
  loadRemoteMediaBuffer: jest.fn(),
}));

// A fake Baileys socket: an event emitter wearing the methods the adapter calls.
class FakeSock extends EventEmitter {
  public ev = {
    on: (event: string, handler: (arg: unknown) => void) => {
      this.emitter.on(event, handler);
    },
    // Mirrors the real Baileys typed event emitter, which exposes removeAllListeners(event).
    removeAllListeners: (event: string) => {
      this.emitter.removeAllListeners(event);
    },
  };
  public emitter = new EventEmitter();
  public user: { id: string; name?: string } | undefined;
  public requestPairingCode = jest.fn().mockResolvedValue('ABCD-EFGH');
  public end = jest.fn();
  public logout = jest.fn().mockResolvedValue(undefined);
  // IQ query surface used by logout(): sends a BinaryNode and resolves the tagged response.
  // Default returns a truthy IQ result (a successful acknowledgement) so tests that don't care can
  // just await logout(); individual tests override the implementation to simulate failure.
  public query = jest.fn().mockResolvedValue({ tag: 'iq', attrs: { type: 'result' } });
  public generateMessageTag = jest.fn().mockReturnValue('TAG-1');
  public sendMessage = jest.fn();
  public onWhatsApp = jest.fn();
  public sendPresenceUpdate = jest.fn().mockResolvedValue(undefined);
  public groupFetchAllParticipating = jest.fn();
  public groupMetadata = jest.fn();
  public groupCreate = jest.fn();
  public groupParticipantsUpdate = jest
    .fn()
    .mockResolvedValue([{ status: '200', jid: '628111@s.whatsapp.net', content: {} }]);
  public groupLeave = jest.fn().mockResolvedValue(undefined);
  public groupUpdateSubject = jest.fn().mockResolvedValue(undefined);
  public groupUpdateDescription = jest.fn().mockResolvedValue(undefined);
  public groupInviteCode = jest.fn();
  public groupRevokeInvite = jest.fn();
  public groupAcceptInvite = jest.fn();
  public groupSettingUpdate = jest.fn().mockResolvedValue(undefined);
  public groupToggleEphemeral = jest.fn().mockResolvedValue(undefined);
  public groupGetInviteInfo = jest.fn();
  public groupMemberAddMode = jest.fn().mockResolvedValue(undefined);
  public profilePictureUrl = jest.fn();
  public updateProfileName = jest.fn().mockResolvedValue(undefined);
  public updateProfileStatus = jest.fn().mockResolvedValue(undefined);
  public updateProfilePicture = jest.fn().mockResolvedValue(undefined);
  public removeProfilePicture = jest.fn().mockResolvedValue(undefined);
  public updateBlockStatus = jest.fn().mockResolvedValue(undefined);
  public addOrEditContact = jest.fn().mockResolvedValue(undefined);
  public removeContact = jest.fn().mockResolvedValue(undefined);
  public readMessages = jest.fn().mockResolvedValue(undefined);
  public chatModify = jest.fn().mockResolvedValue(undefined);
  public addChatLabel = jest.fn().mockResolvedValue(undefined);
  public addLabel = jest.fn().mockResolvedValue(undefined);
  public removeChatLabel = jest.fn().mockResolvedValue(undefined);
  public newsletterMetadata = jest.fn();
  public getCatalog = jest.fn();
  public getCollections = jest.fn();
  public newsletterFollow = jest.fn().mockResolvedValue(undefined);
  public newsletterCreate = jest.fn().mockResolvedValue({ id: 'c@newsletter', name: 'c' });
  public newsletterDelete = jest.fn().mockResolvedValue(undefined);
  public newsletterMute = jest.fn().mockResolvedValue(undefined);
  public newsletterUnmute = jest.fn().mockResolvedValue(undefined);
  public newsletterUnfollow = jest.fn().mockResolvedValue(undefined);
  public rejectCall = jest.fn().mockResolvedValue(undefined);
  public presenceSubscribe = jest.fn().mockResolvedValue(undefined);
  // Baileys answers this by emitting its own connection.update carrying the result, so the default
  // mirrors that: resolving alone proves nothing reached the adapter.
  public fetchAccountReachoutTimelock = jest.fn().mockResolvedValue({ isActive: false });
  public signalRepository: { lidMapping: { getLIDForPN: jest.Mock } } | undefined;
  fire(event: string, arg: unknown): void {
    this.emitter.emit(event, arg);
  }
  resetEmitter(): void {
    this.emitter.removeAllListeners();
  }
}

const fakeSock = new FakeSock();
const saveCreds = jest.fn().mockResolvedValue(undefined);

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(() => {
    fakeSock.resetEmitter();
    return fakeSock;
  }),
  useMultiFileAuthState: jest.fn().mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds }),
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  // Identity passthrough — the adapter wraps state.keys with this for session-store caching; tests
  // don't exercise the caching behavior itself, just need the real store object to flow through.
  makeCacheableSignalKeyStore: jest.fn((store: unknown) => store),
  getContentType: jest.fn(() => 'conversation'),
  // The adapter now downloads via 'stream' mode, so resolve to an async-iterable of chunks (factory is
  // hoisted above imports, so this stays inline; tests override with the `streamOf` helper below).
  downloadMediaMessage: jest.fn(() =>
    Promise.resolve({
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('IMGDATA');
      },
    }),
  ),
  // Identity passthrough by default; individual tests may override to simulate unwrapping.
  normalizeMessageContent: jest.fn((c: unknown) => c),
  // The pinned protocol node targets this JID; exported from the real module's WABinary surface.
  S_WHATSAPP_NET: '@s.whatsapp.net',
  DisconnectReason: { loggedOut: 401, forbidden: 403, restartRequired: 515, connectionReplaced: 440 },
  proto: {
    Message: {
      ProtocolMessage: {
        Type: { REVOKE: 0, MESSAGE_EDIT: 14 },
      },
    },
    // namespace proto.PinInChat { enum Type } — WAProto/index.d.ts:10355-10361
    PinInChat: { Type: { UNKNOWN_TYPE: 0, PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 } },
  },
}));

import { HttpsProxyAgent } from 'https-proxy-agent';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { BaileysAdapter, createProxyAgent } from './baileys.adapter';
import {
  EditedMessage,
  EngineStatus,
  EngineEventCallbacks,
  GroupEvent,
  IncomingCallEvent,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';

const fakeStore = {
  put: jest.fn().mockResolvedValue(undefined),
  getMessage: jest.fn(),
  clearSession: jest.fn().mockResolvedValue(undefined),
};

/** A fresh async-iterable stream of the given chunks (the shape `downloadMediaMessage('stream')` returns). */
function streamOf(...chunks: Buffer[]): AsyncIterable<Buffer> & { destroy: () => void } {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
    destroy: jest.fn(),
  };
}
// sessionId (name) and dbSessionId (Session.id UUID) are deliberately distinct here so assertions
// below prove auth-dir/logging use the name while messageStore (FK-bound) uses the UUID.
const newAdapter = (): BaileysAdapter =>
  new BaileysAdapter({
    sessionId: 'sess-1',
    dbSessionId: 'db-uuid-1',
    authDir: './data/baileys',
    messageStore: fakeStore,
  });

const noopCallbacks = (over: Partial<EngineEventCallbacks> = {}): EngineEventCallbacks => over;

/**
 * Every text send now carries send-options, because that is how the SSRF-safe preview generator
 * replaces the library's own (see safe-link-preview.ts). Matching on the shape rather than
 * `expect.anything()` keeps the assertion honest: the options object disappearing would mean
 * Baileys' vulnerable generator became reachable again.
 */
const safeSendOptions = (): unknown =>
  expect.objectContaining({ getUrlInfo: expect.any(Function) as unknown }) as unknown;

function firstEditedMessage(callback: jest.Mock): EditedMessage {
  const calls = callback.mock.calls as Array<[EditedMessage]>;
  const first = calls[0];
  if (!first) throw new Error('Expected an edited-message callback');
  return first[0];
}

describe('BaileysAdapter lifecycle & status', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter(); // drop listeners from previous test's initialize()
    jest.clearAllMocks();
  });

  it('starts DISCONNECTED', () => {
    expect(newAdapter().getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('renders the QR to a PNG data URL and moves to QR_READY on a connection.update with a qr', async () => {
    // QR rendering (qrcode.toDataURL) is async, so await the real completion signal — the onQRCode
    // callback — rather than guessing tick counts.
    let resolveQr!: (url: string) => void;
    const qrPublished = new Promise<string>(resolve => {
      resolveQr = resolve;
    });
    const onQRCode = jest.fn((url: string) => resolveQr(url));
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onQRCode }));
    fakeSock.fire('connection.update', { qr: 'QR-STRING' });

    const rendered = await qrPublished;
    // The dashboard renders <img src={qrCode}>, so engines must emit a data URL, not the raw ref.
    expect(rendered).toMatch(/^data:image\/png;base64,/);
    expect(adapter.getStatus()).toBe(EngineStatus.QR_READY);
    expect(adapter.getQRCode()).toBe(rendered);
  });

  it('captures phone/pushName and fires onReady on connection open', async () => {
    const onReady = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onReady }));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(adapter.getPhoneNumber()).toBe('628999');
    expect(adapter.getPushName()).toBe('Me');
    expect(onReady).toHaveBeenCalledWith('628999', 'Me');
  });

  it('on a logged-out close: DISCONNECTED, onDisconnected, and NO reconnect', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const onDisconnected = jest.fn();
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({ onDisconnected }));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
      makeWASocket.mockClear();
      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      // The status/socket teardown is synchronous; onDisconnected fires only after the deferred auth
      // removal settles (see handleRemoteLoggedOut).
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      await new Promise(r => setImmediate(r));
      expect(onDisconnected).toHaveBeenCalledWith('logged out');
      expect(makeWASocket).not.toHaveBeenCalled(); // no reconnect
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('on a logged-out close: clears the on-disk auth dir so a fresh connect shows a new QR', async () => {
    // Root cause of the "QR never appears after logout" bug: the now-invalid multi-file auth dir was
    // left on disk, so the next connect() reloaded the dead creds and Baileys retried them instead of
    // emitting a QR. A terminal loggedOut MUST wipe the auth dir.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      await new Promise(r => setImmediate(r)); // let the fire-and-forget clearAuthState() settle
      expect(rmSpy).toHaveBeenCalledWith(
        path.join('./data/baileys', 'sess-1'),
        expect.objectContaining({ recursive: true, force: true }),
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('on a logged-out close: moves DISCONNECTED synchronously, registers the teardown, fires onDisconnected only after the rm resolves', async () => {
    // The WhatsApp-originated cleanup runs as an awaited async helper. The status/socket/live-call
    // teardown must land SYNCHRONOUSLY before any await so the watchdog never processes a READY socket
    // that is already dead; onCredentialTeardownStarted must register the cleanup promise; and
    // onDisconnected fires only after the strict auth removal succeeds.
    let releaseRm!: () => void;
    const rmPromise = new Promise<void>(res => {
      releaseRm = res;
    });
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockReturnValue(rmPromise);
    const onCredentialTeardownStarted = jest.fn((op: Promise<void>) => {
      void op.catch(() => undefined);
    });
    const onDisconnected = jest.fn();
    const onError = jest.fn();
    try {
      const adapter = newAdapter();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
      await adapter.initialize(noopCallbacks({ onCredentialTeardownStarted, onDisconnected, onError }));
      makeWASocket.mockClear(); // only count makeWASocket calls originating from the logged-out path

      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });

      // SYNCHRONOUSLY (before the deferred rm settles): DISCONNECTED, socket nulled, live calls clear.
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect((adapter as unknown as { sock: unknown }).sock).toBeNull();
      expect(onCredentialTeardownStarted).toHaveBeenCalledTimes(1);
      // The registered argument is the same promise the adapter is about to await.
      const registeredOp = onCredentialTeardownStarted.mock.calls[0][0];
      expect(typeof registeredOp.then).toBe('function');
      expect(makeWASocket).not.toHaveBeenCalled(); // no reconnect scheduled
      // onDisconnected has NOT fired yet — the rm is still pending.
      expect(onDisconnected).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      releaseRm();
      await new Promise(r => setImmediate(r)); // let the awaited helper settle

      expect(rmSpy).toHaveBeenCalledWith(
        path.join('./data/baileys', 'sess-1'),
        expect.objectContaining({ recursive: true, force: true }),
      );
      expect(onDisconnected).toHaveBeenCalledWith('logged out');
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED); // still DISCONNECTED on success
      expect(onError).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('on a logged-out close: a failed auth removal becomes terminal FAILED + onError (NOT disconnected/reconnect)', async () => {
    // A clearAuthState() that rethrows must surface as a terminal error so the operator learns the
    // credentials did not actually get wiped. It must not look like a clean disconnect or schedule a
    // reconnect with known-invalid auth.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('disk error'));
    const onDisconnected = jest.fn();
    const onError = jest.fn();
    try {
      const adapter = newAdapter();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
      await adapter.initialize(noopCallbacks({ onDisconnected, onError }));
      makeWASocket.mockClear(); // only count makeWASocket calls originating from the logged-out path

      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      await new Promise(r => setImmediate(r)); // let the awaited helper settle on the rejection

      expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('disk error'));
      expect(onDisconnected).not.toHaveBeenCalled(); // success path did not run
      expect(makeWASocket).not.toHaveBeenCalled(); // no reconnect
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('logout() clears the on-disk auth dir only AFTER an IQ result acknowledges the unlink', async () => {
    // 200 = engine-native unlink completed AND required local credential cleanup completed. The auth
    // dir must be removed only after a valid IQ response; removing it earlier would leave the device
    // linked server-side with no local credentials to retry with.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };

      await adapter.logout();

      // remove-companion-device IQ went out through query() with the pinned protocol node and the
      // 8s acknowledgement timeout. Auth dir removal happened only after the truthy IQ result.
      expect(fakeSock.query).toHaveBeenCalledTimes(1);
      const [node, timeoutMs] = fakeSock.query.mock.calls[0] as [
        {
          tag: string;
          attrs: { to: string; type: string; id: string; xmlns: string };
          content: Array<{ tag: string; attrs: { jid: string; reason: string } }>;
        },
        number,
      ];
      expect(node.tag).toBe('iq');
      expect(node.attrs).toEqual({
        to: '@s.whatsapp.net',
        type: 'set',
        id: 'TAG-1',
        xmlns: 'md',
      });
      expect(node.content).toEqual([
        { tag: 'remove-companion-device', attrs: { jid: '628999:12@s.whatsapp.net', reason: 'user_initiated' } },
      ]);
      expect(timeoutMs).toBe(8_000);
      expect(rmSpy).toHaveBeenCalledWith(
        path.join('./data/baileys', 'sess-1'),
        expect.objectContaining({ recursive: true, force: true }),
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('logout() never calls sock.logout() — the IQ query is the unlink contract', async () => {
    // Baileys sock.logout() resolves on WebSocket write flush (NOT an IQ ack) and transmits nothing
    // when creds.me is unset, so it is intentionally NOT used.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };

      await adapter.logout();

      expect(fakeSock.logout).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('logout() with missing companion identity rejects, sends nothing, preserves auth, and stops locally', async () => {
    // No creds.me.id → the unlink cannot be addressed. The promise must reject, query()/rm() must NOT
    // run, and the live socket must be torn down locally so no engine orphan remains.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.user = undefined; // no linked companion identity
      (adapter as unknown as { sock: unknown }).sock = fakeSock;

      await expect(adapter.logout()).rejects.toThrow(/no linked companion identity/i);

      expect(fakeSock.query).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
      // Failure still stops the socket locally: end() called, status DISCONNECTED, socket nulled.
      expect(fakeSock.end).toHaveBeenCalled();
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect((adapter as unknown as { sock: unknown }).sock).toBeNull();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('logout() with an undefined IQ response rejects, preserves auth, and stops locally', async () => {
    // WhatsApp returned no result for the unlink request — completion requires a truthy response, so
    // this is an incomplete operation (502 at the service). Auth survives; the socket still dies.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
      fakeSock.query.mockResolvedValueOnce(undefined);

      await expect(adapter.logout()).rejects.toThrow(/did not acknowledge the unlink/i);

      expect(fakeSock.query).toHaveBeenCalledTimes(1);
      expect(rmSpy).not.toHaveBeenCalled();
      expect(fakeSock.end).toHaveBeenCalled();
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect((adapter as unknown as { sock: unknown }).sock).toBeNull();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('logout() with a query rejection/timeout rejects, preserves auth, and stops locally', async () => {
    // A transport error or 8s timeout from query() is an incomplete operation. Auth must NOT be
    // removed (the link may still be valid server-side); the socket still ends locally.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
      fakeSock.query.mockRejectedValueOnce(new Error('Timed Out'));

      await expect(adapter.logout()).rejects.toThrow('Timed Out');

      expect(fakeSock.query).toHaveBeenCalledTimes(1);
      expect(rmSpy).not.toHaveBeenCalled();
      expect(fakeSock.end).toHaveBeenCalled();
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect((adapter as unknown as { sock: unknown }).sock).toBeNull();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('logout() with an acknowledged IQ but fs.rm failure STILL rejects', async () => {
    // Completion requires auth dir removal too. Even after a valid IQ result, a failed credential
    // removal propagates (the operation is incomplete), so 200 is never reported.
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('disk full'));
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };

      await expect(adapter.logout()).rejects.toThrow('disk full');

      expect(fakeSock.query).toHaveBeenCalledTimes(1);
      expect(rmSpy).toHaveBeenCalledWith(
        path.join('./data/baileys', 'sess-1'),
        expect.objectContaining({ recursive: true, force: true }),
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  // With no socket the unlink cannot be sent, and an optional-chained call would resolve as though it
  // had been — reporting a confirmed unlink, writing the audit row, and wiping the credentials, all
  // while the device stayed linked server-side with nothing left to retry with. Reachable whenever the
  // socket is gone but the engine is still registered, e.g. inside a reconnect backoff.
  it('logout() rejects and keeps the on-disk auth dir when there is no socket at all', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      (adapter as unknown as { sock: unknown }).sock = null;

      await expect(adapter.logout()).rejects.toThrow(/no live whatsapp socket/i);
      expect(fakeSock.query).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('on a recoverable close: reconnects (re-creates the socket) and does NOT fire onDisconnected', async () => {
    const onDisconnected = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onDisconnected }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const makeWASocket = jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;
    makeWASocket.mockClear();

    // Reconnect is backoff-delayed (1 s + up to 1 s jitter on the first attempt): advance past the
    // worst-case delay with fake timers.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 515 } } },
      });
      jest.advanceTimersByTime(2_000);
      await new Promise(r => setImmediate(r)); // let the async connect() body reach makeWASocket
      expect(makeWASocket).toHaveBeenCalledTimes(1);
      expect(onDisconnected).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('disconnect() ends the socket and does not reconnect', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    await adapter.disconnect();
    expect(fakeSock.end).toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('requestPairingCode throws EngineNotReadyError before initialize()', async () => {
    const adapter = newAdapter();
    await expect(adapter.requestPairingCode('628999')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('requestPairingCode delegates to the socket', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    await expect(adapter.requestPairingCode('628999')).resolves.toBe('ABCD-EFGH');
    expect(fakeSock.requestPairingCode).toHaveBeenCalledWith('628999');
  });

  it('persists creds: subscribes saveCreds to creds.update', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.fire('creds.update', {});
    expect(saveCreds).toHaveBeenCalled();
  });

  // C2 — resurrect-after-stop race
  it('C2: disconnect() during in-flight connect does NOT assign a socket or reach READY', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      fetchLatestBaileysVersion: jest.Mock;
      default: jest.Mock;
    };

    // Make fetchLatestBaileysVersion block until we manually resolve it.
    let resolveVersion!: (v: { version: number[] }) => void;
    const versionPromise = new Promise<{ version: number[] }>(res => {
      resolveVersion = res;
    });
    baileys.fetchLatestBaileysVersion.mockReturnValueOnce(versionPromise);
    baileys.default.mockClear();

    const adapter = newAdapter();
    const initPromise = adapter.initialize(noopCallbacks({}));

    // While connect() is blocked waiting for fetchLatestBaileysVersion, call disconnect().
    await adapter.disconnect();

    // Now resolve the version fetch.
    resolveVersion({ version: [2, 3000, 0] });
    await initPromise.catch(() => undefined); // initialize() resolves regardless

    // The connect() body should have bailed out: no socket created, not READY.
    expect(baileys.default).not.toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  // I5 — first-connect error surfacing
  it('I5: first connect failure → initialize() rejects, status FAILED, onError fired', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      fetchLatestBaileysVersion: jest.Mock;
    };
    baileys.fetchLatestBaileysVersion.mockRejectedValueOnce(new Error('network error'));

    const onError = jest.fn();
    const adapter = newAdapter();
    await expect(adapter.initialize(noopCallbacks({ onError }))).rejects.toThrow('network error');
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledWith('network error');
  });

  // Teardown-before-initialize: the adapter is single-use once torn down. The intentionalClose latch
  // is set by disconnect()/destroy()/forceDestroy()/logout() and must NEVER be re-armed by a later
  // initialize() — otherwise a retired adapter opens a fresh socket no caller is tracking.
  describe('teardown-before-initialize (single-use adapter)', () => {
    const makeWASocket = (): jest.Mock =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;

    it.each([{ method: 'disconnect' as const }, { method: 'destroy' as const }, { method: 'forceDestroy' as const }])(
      '%s() before initialize() does not create a socket, and a later initialize() still does not',
      async ({ method }) => {
        makeWASocket().mockClear();
        const adapter = newAdapter();
        // A brand-new adapter has never connected: tearing it down must not touch the socket factory.
        await adapter[method]();
        expect(makeWASocket()).not.toHaveBeenCalled();
        expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);

        // The teardown latch must NOT be re-armed by initialize(): a retired adapter stays retired.
        makeWASocket().mockClear();
        await adapter.initialize(noopCallbacks({}));
        expect(makeWASocket()).not.toHaveBeenCalled();
      },
    );

    it('logout() before initialize() rejects (no socket) and a subsequent initialize() still does not make a socket', async () => {
      makeWASocket().mockClear();
      const adapter = newAdapter();
      // No socket was ever created, so the unlink cannot be sent.
      await expect(adapter.logout()).rejects.toThrow(/no live whatsapp socket/i);
      expect(makeWASocket()).not.toHaveBeenCalled();

      // The teardown latch set by logout() must hold: initialize() must not open a fresh socket on a
      // retired adapter.
      makeWASocket().mockClear();
      await adapter.initialize(noopCallbacks({}));
      expect(makeWASocket()).not.toHaveBeenCalled();
    });
  });
});

describe('BaileysAdapter reconnect policy — unlimited backoff (I4 hardening)', () => {
  const baileys = () =>
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    jest.requireMock('@whiskeysockets/baileys') as { default: jest.Mock; fetchLatestBaileysVersion: jest.Mock };

  const fireRecoverableClose = (): void => {
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
  };

  // Helper: initialize the adapter with REAL timers (loadLib uses dynamic import),
  // then hand the test an adapter ready for fake-timer-driven reconnect testing.
  const initWithRealTimers = async (over: Partial<EngineEventCallbacks> = {}): Promise<BaileysAdapter> => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks(over));
    return adapter;
  };

  afterEach(() => {
    // Ensure fake timers / Math.random spies are always cleaned up even if a test fails mid-way.
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('unlimited retry: closes beyond the old 5-attempt cap keep reconnecting, backoff capped at 60 s', async () => {
    const onError = jest.fn();
    const adapter = await initWithRealTimers({ onError });
    baileys().default.mockClear();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministic delays (jitter = 0)

    // 7 recoverable drops — beyond the old MAX_RECONNECT_ATTEMPTS (5). Each close schedules a
    // reconnect; consecutive closes land 61 s apart, so the 5-min stability reset never trips
    // and the attempt counter climbs 1..7 (delays 1/2/4/8/16/32/60 s).
    for (let i = 0; i < 7; i++) {
      fireRecoverableClose();
      await jest.advanceTimersByTimeAsync(61_000); // covers any delay up to the 60 s cap
    }
    expect(baileys().default).toHaveBeenCalledTimes(7);

    // Attempt 8: 2^(8-1) s = 128 s would EXCEED the cap — the scheduled delay must be exactly 60 s
    // (advancing precisely 60 s fires the timer only when the cap held).
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(baileys().default).toHaveBeenCalledTimes(8);

    // No FAILED, no terminal onError — the "reconnect attempts exhausted" path is gone entirely.
    expect(adapter.getStatus()).not.toBe(EngineStatus.FAILED);
    expect(onError).not.toHaveBeenCalled();
  });

  it('successful connection resets the reconnect counter (next drop uses the attempt-1 delay)', async () => {
    const adapter = await initWithRealTimers({});
    baileys().default.mockClear();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);

    // Drop + reconnect — the counter is now 1 (no 'open' yet).
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(baileys().default).toHaveBeenCalledTimes(1);

    // Simulate a successful open — should reset the reconnect counter to 0.
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);

    // The next drop must schedule attempt 1 (1 s), not attempt 2 (2 s): 1.5 s settles it.
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(baileys().default).toHaveBeenCalledTimes(2);
  });

  it('stability reset: a close >5 min after the previous close restarts the backoff at attempt 1', async () => {
    await initWithRealTimers({});
    baileys().default.mockClear();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);

    // First drop → attempt 1 (1 s); the reconnect succeeds but no 'open' arrives, so the counter
    // stays at 1 — only the stability window can clear it.
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(baileys().default).toHaveBeenCalledTimes(1);

    // Jump the clock past the 5-minute stability window without running timers (none are pending).
    jest.setSystemTime(Date.now() + 6 * 60_000);

    // A healthy-then-dropped connection must not inherit the old counter: attempt 1 (1 s), not
    // attempt 2 (2 s) — 1.5 s settles it.
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(baileys().default).toHaveBeenCalledTimes(2);
  });

  it('duplicate close while a reconnect timer is pending does NOT burn an attempt', async () => {
    await initWithRealTimers({});
    baileys().default.mockClear();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);

    // Close #1 schedules attempt 1 (1 s); the duplicate close must be ignored WITHOUT incrementing.
    fireRecoverableClose();
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(baileys().default).toHaveBeenCalledTimes(1);

    // The next close must therefore schedule attempt 2 (2 s) — not attempt 3 (4 s), which is what
    // a burned duplicate increment would produce. 2.5 s settles it.
    fireRecoverableClose();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(baileys().default).toHaveBeenCalledTimes(2);
  });

  it('a connect() failure inside an attempt schedules the NEXT attempt (no FAILED, no onError)', async () => {
    const onError = jest.fn();
    const adapter = await initWithRealTimers({ onError });
    baileys().default.mockClear();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);

    // The first reconnect attempt fails inside connect() (e.g. fetchLatestBaileysVersion offline).
    baileys().fetchLatestBaileysVersion.mockRejectedValueOnce(new Error('network down'));

    fireRecoverableClose(); // attempt 1 (1 s)
    await jest.advanceTimersByTimeAsync(1_000); // attempt 1 runs and FAILS → must schedule attempt 2 (2 s)
    expect(adapter.getStatus()).not.toBe(EngineStatus.FAILED);
    expect(onError).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000); // attempt 2 runs and succeeds
    expect(baileys().default).toHaveBeenCalledTimes(1); // one socket from the successful retry
    expect(adapter.getStatus()).not.toBe(EngineStatus.FAILED);
    expect(onError).not.toHaveBeenCalled();
  });

  it('440 connectionReplaced is terminal: FAILED + onError, NO reconnect, auth NOT cleared', async () => {
    const onError = jest.fn();
    const adapter = await initWithRealTimers({ onError });
    baileys().default.mockClear();
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      jest.useFakeTimers();

      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 440 } } },
      });
      await jest.runAllTimersAsync(); // would run any scheduled reconnect — none must be scheduled

      expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('Connection replaced by another instance (440)'));
      expect(baileys().default).not.toHaveBeenCalled(); // no reconnect — would fight the other instance
      expect(rmSpy).not.toHaveBeenCalled(); // auth survives — unlike loggedOut, the link is still valid
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('403 forbidden is terminal: FAILED + onError, NO reconnect, auth NOT cleared', async () => {
    const onError = jest.fn();
    const adapter = await initWithRealTimers({ onError });
    baileys().default.mockClear();
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      jest.useFakeTimers();

      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 403 } } },
      });
      await jest.runAllTimersAsync(); // would run any scheduled reconnect — none must be scheduled

      expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('Account rejected by WhatsApp (403)'));
      expect(baileys().default).not.toHaveBeenCalled(); // no reconnect — account is banned/blocked
      expect(rmSpy).not.toHaveBeenCalled(); // auth survives — account-level refusal, not dead creds
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('a recoverable close after disconnect() (intentionalClose) does NOT schedule a reconnect', async () => {
    const adapter = await initWithRealTimers({});
    baileys().default.mockClear();

    jest.useFakeTimers();

    await adapter.disconnect();
    // Fire a close event after intentional disconnect — must be ignored entirely
    fireRecoverableClose();
    await jest.runAllTimersAsync();

    expect(baileys().default).not.toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('backoff timers are used — first reconnect is delayed ~1 s (not immediate)', async () => {
    await initWithRealTimers({});
    baileys().default.mockClear();

    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministic delay: exactly 1 s

    // First drop: should schedule at delay = 1000 ms (2^0 * 1000)
    fireRecoverableClose();

    // Advance only 500 ms — connect should NOT have been called yet
    jest.advanceTimersByTime(500);
    await new Promise<void>(r => setImmediate(r));
    expect(baileys().default).not.toHaveBeenCalled();

    // Advance remaining 500 ms → timer fires → connect() is invoked
    jest.advanceTimersByTime(500);
    await new Promise<void>(r => setImmediate(r));
    expect(baileys().default).toHaveBeenCalledTimes(1);
  });
});

describe('BaileysAdapter probeLiveness', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  it('is false before initialize (no socket, not READY)', async () => {
    const adapter = newAdapter();
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('is false while INITIALIZING (socket exists but the connection is not open)', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    expect(adapter.getStatus()).toBe(EngineStatus.INITIALIZING);
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('is true when READY with a live socket, false again after disconnect', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.fire('connection.update', { connection: 'open' });
    await expect(adapter.probeLiveness()).resolves.toBe(true);

    await adapter.disconnect(); // ends the socket → no longer live
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });
});

describe('BaileysAdapter reconnect socket teardown (no leak)', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baileys = () => jest.requireMock('@whiskeysockets/baileys') as { default: jest.Mock };

  const fireRecoverableClose = (): void => {
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
  };

  const initWithRealTimers = async (): Promise<BaileysAdapter> => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    return adapter;
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ends the previous socket when an internal reconnect replaces it', async () => {
    const adapter = await initWithRealTimers();
    jest.useFakeTimers();
    fakeSock.end.mockClear(); // only count end() calls originating from the reconnect path

    fireRecoverableClose();
    await jest.runAllTimersAsync(); // reconnect runs connectInner → must tear down the old socket first

    // Before the fix, end() is only called by disconnect/logout/destroy — never on reconnect,
    // so the prior socket + its listeners leak on every transient drop.
    expect(fakeSock.end).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus()).not.toBe(EngineStatus.FAILED);
  });

  it('tearing down the previous socket does not trigger a spurious second reconnect', async () => {
    const adapter = await initWithRealTimers();
    jest.useFakeTimers();
    baileys().default.mockClear();

    // Real Baileys end() synchronously emits a connection.update {connection:'close'} before it
    // detaches its own listener. If our handler is still attached when end() runs (wrong teardown
    // order), that synthetic close re-enters handleConnectionUpdate and schedules a 2nd reconnect.
    fakeSock.end.mockImplementationOnce(() => {
      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 515 } } },
      });
    });

    fireRecoverableClose();
    await jest.runAllTimersAsync();

    // Exactly one legitimate reconnect — the synthetic close from end() must land on zero listeners.
    expect(baileys().default).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus()).not.toBe(EngineStatus.FAILED);
  });
});

describe('BaileysAdapter status honesty across the reconnect backoff', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baileys = () => jest.requireMock('@whiskeysockets/baileys') as { default: jest.Mock };

  const fireRecoverableClose = (): void => {
    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
  };

  const initReady = async (over: Partial<EngineEventCallbacks> = {}): Promise<BaileysAdapter> => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks(over));
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a transient close drops the session to INITIALIZING immediately — no READY across the backoff', async () => {
    const states: EngineStatus[] = [];
    const adapter = await initReady({ onStateChanged: s => states.push(s) });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    states.length = 0; // count only the transitions from READY onward

    jest.useFakeTimers();
    fireRecoverableClose();

    // The reconnect timer is still pending (first attempt is ~1 s out, later ones up to 60 s) and
    // the socket is already dead — the session must NOT read READY in this window.
    expect(adapter.getStatus()).toBe(EngineStatus.INITIALIZING);
    await expect(adapter.probeLiveness()).resolves.toBe(false);
    expect(states).toEqual([EngineStatus.INITIALIZING]);
  });

  it('stays INITIALIZING until the reconnected socket actually opens, then reports READY again', async () => {
    const adapter = await initReady({});
    baileys().default.mockClear();
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0); // deterministic 1 s first-attempt delay

    fireRecoverableClose();
    expect(adapter.getStatus()).toBe(EngineStatus.INITIALIZING);

    await jest.advanceTimersByTimeAsync(1_000); // attempt 1 runs → new socket created
    expect(baileys().default).toHaveBeenCalledTimes(1);
    // The new socket exists but has not opened yet — still not READY.
    expect(adapter.getStatus()).toBe(EngineStatus.INITIALIZING);

    fakeSock.fire('connection.update', { connection: 'open' });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
  });

  it('back-to-back transient closes do not flap onStateChanged', async () => {
    const states: EngineStatus[] = [];
    await initReady({ onStateChanged: s => states.push(s) });
    states.length = 0; // count only the transitions from READY onward

    jest.useFakeTimers();
    fireRecoverableClose();
    fireRecoverableClose(); // duplicate for the same drop — ignored, no extra transition
    expect(states).toEqual([EngineStatus.INITIALIZING]);

    await jest.advanceTimersByTimeAsync(2_000); // let the pending attempt run (1 s + jitter)
    fireRecoverableClose(); // the next drop lands while already INITIALIZING — still no emission
    expect(states).toEqual([EngineStatus.INITIALIZING]);
  });

  it('a logged-out close still reports DISCONNECTED (terminal behavior unchanged)', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const onDisconnected = jest.fn();
      const adapter = await initReady({ onDisconnected });

      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });

      // The status is DISCONNECTED synchronously; onDisconnected fires after the deferred auth removal.
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      await new Promise(r => setImmediate(r));
      expect(onDisconnected).toHaveBeenCalledWith('logged out');
      await expect(adapter.probeLiveness()).resolves.toBe(false);
    } finally {
      rmSpy.mockRestore();
    }
  });
});

describe('BaileysAdapter capability gating', () => {
  it('throws EngineNotSupportedError for still-gated methods (e.g. getChatHistory)', async () => {
    const adapter = newAdapter();
    await expect(adapter.getChatHistory('628111@s.whatsapp.net')).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
});

describe('BaileysAdapter location + contact + poll sends', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M2' }, messageTimestamp: 1700000006 });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendLocationMessage maps lat/long + optional name/address', async () => {
    const adapter = await ready();
    await adapter.sendLocationMessage('628111@s.whatsapp.net', {
      latitude: 24.12,
      longitude: 55.11,
      description: 'Office',
      address: '1 Main St',
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      location: { degreesLatitude: 24.12, degreesLongitude: 55.11, name: 'Office', address: '1 Main St' },
    });
  });

  it('sendContactMessage builds a vCard with the waid', async () => {
    const adapter = await ready();
    await adapter.sendContactMessage('628111@s.whatsapp.net', { name: 'John Doe', number: '+1 234-567' });
    const [, call] = fakeSock.sendMessage.mock.calls[0] as [
      string,
      { contacts: { displayName: string; contacts: { vcard: string }[] } },
    ];
    expect(call.contacts.displayName).toBe('John Doe');
    const vcard = call.contacts.contacts[0].vcard;
    expect(vcard).toContain('FN:John Doe');
    expect(vcard).toContain('waid=1234567:+1 234-567');
    expect(vcard.startsWith('BEGIN:VCARD')).toBe(true);
  });

  it('sanitizes CRLF in a contact name to prevent vCard line-injection', async () => {
    const adapter = await ready();
    await adapter.sendContactMessage('628111@s.whatsapp.net', { name: 'Eve\nEMAIL:evil@x.com', number: '123' });
    const [, call] = fakeSock.sendMessage.mock.calls[0] as [string, { contacts: { contacts: { vcard: string }[] } }];
    const vcard = call.contacts.contacts[0].vcard;
    expect(vcard).not.toMatch(/\nEMAIL:evil@x\.com/);
    expect(vcard).toContain('FN:Eve EMAIL:evil@x.com');
  });

  it('sendPollMessage maps name/values and defaults to single choice (selectableCount 1)', async () => {
    const adapter = await ready();
    await adapter.sendPollMessage('120363000@g.us', { name: 'Where?', options: ['Park', 'Beach'] });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('120363000@g.us', {
      poll: { name: 'Where?', values: ['Park', 'Beach'], selectableCount: 1 },
    });
  });

  it('sendPollMessage uses selectableCount 0 (no limit) when multiple answers are allowed', async () => {
    const adapter = await ready();
    await adapter.sendPollMessage('120363000@g.us', {
      name: 'Toppings?',
      options: ['Cheese', 'Ham', 'Olives'],
      allowMultipleAnswers: true,
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('120363000@g.us', {
      poll: { name: 'Toppings?', values: ['Cheese', 'Ham', 'Olives'], selectableCount: 0 },
    });
  });
});

describe('BaileysAdapter messaging', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.signalRepository = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyAdapter = async (over: Partial<EngineEventCallbacks> = {}): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize(over);
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendTextMessage calls sock.sendMessage(jid, { text }) and returns the message id', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    const res = await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      { text: 'hello', linkPreview: null },
      safeSendOptions(),
    );
    expect(res).toEqual({ id: 'OUT1', timestamp: 1700000001 });
  });

  it('emits onMessageCreate for the own send so message.sent fires (parity with the wwjs engine)', async () => {
    const onMessageCreate = jest.fn();
    // A realistic own-send return: fromMe + remoteJid + content, which the API-send echo path maps.
    fakeSock.sendMessage.mockResolvedValue({
      key: { id: 'OUT1', fromMe: true, remoteJid: '628111@s.whatsapp.net' },
      message: { conversation: 'hello' },
      messageTimestamp: 1700000001,
    });
    const adapter = await readyAdapter({ onMessageCreate });
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    // The echo is emitted off the response path via an async mapMessage chain; let it settle.
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));

    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'OUT1', fromMe: true, body: 'hello', type: 'text' }),
    );
  });

  it('skips the own-send echo when the returned message carries no neutral content (best-effort)', async () => {
    const onMessageCreate = jest.fn();
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter({ onMessageCreate });
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hi');
    await new Promise(resolve => setImmediate(resolve));

    expect(onMessageCreate).not.toHaveBeenCalled();
  });

  it('sendTextMessage resolves a phone-dialect 1:1 id to the known LID (463 tctoken fix)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    fakeSock.signalRepository = { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue('484848@lid') } };
    const adapter = await readyAdapter();
    await adapter.sendTextMessage('628111@c.us', 'hello');
    expect(fakeSock.signalRepository.lidMapping.getLIDForPN).toHaveBeenCalledWith('628111@s.whatsapp.net');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '484848@lid',
      { text: 'hello', linkPreview: null },
      safeSendOptions(),
    );
  });

  // Resolving a contact's LID at send time is the one place a cold contact's mapping is learned
  // before any message arrives; without writing it back, a later message-target ownership check
  // comparing the stored key's lid against a phone-dialect chatId rejects a message that IS in chat.
  it('sendTextMessage records the resolved LID back into the session store (device-stripped)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    fakeSock.signalRepository = { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue('484848:3@lid') } };
    const adapter = await readyAdapter();
    const store = (adapter as unknown as { sessionStore: { addLidMappings: (m: unknown[]) => void } }).sessionStore;
    const spy = jest.spyOn(store, 'addLidMappings');

    await adapter.sendTextMessage('628111@c.us', 'hello');

    // The device suffix (:3) is stripped — that is the key the lid->phone lookup reads.
    expect(spy).toHaveBeenCalledWith([{ lid: '484848@lid', pn: '628111@s.whatsapp.net' }]);
  });

  it('sendTextMessage keeps the phone jid when no LID mapping is known', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    fakeSock.signalRepository = { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue(null) } };
    const adapter = await readyAdapter();
    await adapter.sendTextMessage('628111@c.us', 'hello');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@c.us',
      { text: 'hello', linkPreview: null },
      safeSendOptions(),
    );
  });

  it('sendTextMessage honors the chat disappearing timer when one is cached (#473)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    fakeSock.fire('chats.upsert', [{ id: '628111@s.whatsapp.net', ephemeralExpiration: 604800 }]);
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      { text: 'hello', linkPreview: null },
      // The disappearing timer still rides on the same options object the generator now shares.
      expect.objectContaining({ ephemeralExpiration: 604800, getUrlInfo: expect.any(Function) as unknown }) as unknown,
    );
  });

  it('sendTextMessage de-normalizes mentions to engine jids (#530)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    await adapter.sendTextMessage('120@g.us', 'hi @62811', ['62811@c.us']);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '120@g.us',
      { text: 'hi @62811', mentions: ['62811@s.whatsapp.net'], linkPreview: null },
      safeSendOptions(),
    );
  });

  it('sendTextMessage omits the mentions key when none are given (no behavior change)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    await adapter.sendTextMessage('120@g.us', 'plain', []);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '120@g.us',
      { text: 'plain', linkPreview: null },
      safeSendOptions(),
    );
  });

  it('getNumberId resolves via onWhatsApp and returns a NEUTRAL jid (never @s.whatsapp.net)', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: true }]);
    const adapter = await readyAdapter();
    // Must cross the engine boundary in the neutral dialect, matching whatsapp-web.js (<phone>@c.us).
    await expect(adapter.getNumberId('628111')).resolves.toBe('628111@c.us');
    await expect(adapter.checkNumberExists('628111')).resolves.toBe(true);
  });

  it('getNumberId returns null when the number is not on WhatsApp', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: false }]);
    const adapter = await readyAdapter();
    await expect(adapter.getNumberId('628111')).resolves.toBeNull();
    await expect(adapter.checkNumberExists('628111')).resolves.toBe(false);
  });

  it('sendChatState maps typing -> composing presence', async () => {
    const adapter = await readyAdapter();
    await adapter.sendChatState('628111@s.whatsapp.net', 'typing');
    expect(fakeSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', '628111@s.whatsapp.net');
  });

  it('sendChatState swallows a presence failure (best-effort, mirrors wwjs) (#583 R4)', async () => {
    const adapter = await readyAdapter();
    fakeSock.sendPresenceUpdate.mockRejectedValueOnce(new Error('No LID for user'));
    await expect(adapter.sendChatState('628111@s.whatsapp.net', 'typing')).resolves.toBeUndefined();
  });

  it('messaging methods throw EngineNotReadyError before the connection is open', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.sendTextMessage('x', 'y')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.getNumberId('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.sendChatState('628111@s.whatsapp.net', 'typing')).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter inbound fan-out', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baileys = jest.requireMock('@whiskeysockets/baileys') as {
    getContentType: jest.Mock;
    normalizeMessageContent: jest.Mock;
  };

  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    baileys.getContentType.mockReturnValue('conversation');
    // clearAllMocks() wipes call history but keeps implementations, so a prior test's
    // normalizeMessageContent override would leak into the next; reset it to the identity default.
    baileys.normalizeMessageContent.mockImplementation((c: unknown) => c);
  });

  it('routes an inbound (not fromMe) message to onMessage with a neutral shape', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN1' },
          message: { conversation: 'hi there' },
          messageTimestamp: 1700000002,
          pushName: 'Alice',
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { id: string; body: string; type: string; fromMe: boolean };
    expect(msg).toMatchObject({ id: 'IN1', body: 'hi there', type: 'text', fromMe: false });
  });

  it('routes a status broadcast to onMessage with the poster in author (so the status store can ingest it)', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          // A contact's status: remoteJid is the shared channel, the poster is in participant.
          key: { remoteJid: 'status@broadcast', participant: '628111@s.whatsapp.net', fromMe: false, id: 'ST1' },
          message: { conversation: 'my status' },
          messageTimestamp: 1700000002,
          pushName: 'Alice',
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { id: string; author?: string; isStatusBroadcast: boolean };
    // Regression lock: buildIncomingStatus needs author to resolve the poster — without it the
    // status resolves to the status@broadcast pseudo-JID and is dropped before ingest.
    expect(msg).toMatchObject({ id: 'ST1', isStatusBroadcast: true, author: '628111@c.us' });
  });

  it('extracts text-status styling (backgroundArgb/font) from the extended-text content', async () => {
    baileys.getContentType.mockReturnValue('extendedTextMessage');
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'status@broadcast', participant: '628111@s.whatsapp.net', fromMe: false, id: 'ST2' },
          message: { extendedTextMessage: { text: 'styled story', backgroundArgb: 0xff123456, font: 3 } },
          messageTimestamp: 1700000002,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { backgroundColor?: string; font?: number };
    expect(msg.backgroundColor).toBe('#123456');
    expect(msg.font).toBe(3);
  });

  it('extracts coordinates from an ephemeral (disappearing) location message', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    const inner = {
      locationMessage: { degreesLatitude: 24.1, degreesLongitude: 55.2, name: 'Office', address: '1 Main St' },
    };
    baileys.getContentType.mockReturnValue('locationMessage');
    baileys.normalizeMessageContent.mockReturnValue(inner); // unwrap the ephemeral wrapper
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'LOC1' },
          message: { ephemeralMessage: { message: inner } }, // wrapped location
          messageTimestamp: 1700000002,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { location?: Record<string, unknown> };
    expect(msg.location).toMatchObject({
      latitude: 24.1,
      longitude: 55.2,
      description: 'Office',
      address: '1 Main St',
    });
  });

  it('maps an ephemeral-wrapped history message to its real type and body (not unknown/empty)', async () => {
    const onHistoryMessages = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onHistoryMessages });
    const inner = { conversation: 'disappearing hello' };
    baileys.normalizeMessageContent.mockReturnValue(inner); // unwrap the ephemeral wrapper
    baileys.getContentType.mockReturnValue('conversation');
    fakeSock.fire('messaging-history.set', {
      contacts: [],
      chats: [],
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'H1' },
          message: { ephemeralMessage: { message: inner } },
          messageTimestamp: 1700000000,
          pushName: 'Alice',
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(onHistoryMessages).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const mapped = onHistoryMessages.mock.calls[0][0] as Array<{ id: string; type: string; body: string }>;
    expect(mapped[0]).toMatchObject({ id: 'H1', type: 'text', body: 'disappearing hello' });
  });

  it('surfaces inbound @mentions as neutral mentionedIds (contextInfo.mentionedJid)', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '120@g.us', participant: '628222@s.whatsapp.net', fromMe: false, id: 'IN_MENTION' },
          message: {
            extendedTextMessage: { text: '@628111 hi', contextInfo: { mentionedJid: ['628111@s.whatsapp.net'] } },
          },
          messageTimestamp: 1700000002,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { mentionedIds?: string[] };
    expect(msg.mentionedIds).toEqual(['628111@c.us']);
  });

  it('omits mentionedIds on an inbound message without @mentions', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN_NOMENTION' },
          message: { conversation: 'plain text' },
          messageTimestamp: 1700000003,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { mentionedIds?: string[] };
    expect(msg.mentionedIds).toBeUndefined();
  });

  it('canonicalizes an inbound message JID from @s.whatsapp.net to @c.us', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN_C' },
          message: { conversation: 'hi' },
          messageTimestamp: 1700000002,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { from: string; to: string; chatId: string };
    expect(msg.from).toBe('628111@c.us');
    expect(msg.to).toBe('628999@c.us'); // self (fakeSock.user is 628999)
    expect(msg.chatId).toBe('628111@c.us');
  });

  it('resolves an @lid sender to <phone>@c.us using a history-sync lid->pn mapping', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    // History sync supplies the lid -> phone mapping the resolver needs.
    fakeSock.fire('messaging-history.set', { lidPnMappings: [{ lid: '111@lid', pn: '628111@s.whatsapp.net' }] });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '111@lid', fromMe: false, id: 'IN_LID' },
          message: { conversation: 'hi from lid' },
          messageTimestamp: 1700000005,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { from: string; isLidSender?: boolean };
    expect(msg.from).toBe('628111@c.us'); // lid resolved to phone, neutral dialect
    expect(msg.isLidSender).toBe(true); // still flagged: the raw sender was a lid
  });

  it('resolves an @lid sender via the lid/pn pair carried on the inbound message key (#362)', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    // No history-sync mapping this time; the inbound key itself carries remoteJid + remoteJidAlt,
    // which is the only place a fresh @lid sender's number is revealed on the key in baileys v7.
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '111@lid',
            fromMe: false,
            id: 'IN_LID_KEY',
            remoteJidAlt: '628111@s.whatsapp.net',
          },
          message: { conversation: 'hi from lid' },
          messageTimestamp: 1700000005,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { from: string; isLidSender?: boolean };
    expect(msg.from).toBe('628111@c.us'); // resolved from the key's remoteJidAlt, neutral dialect
    expect(msg.isLidSender).toBe(true);
  });

  it('keeps an unresolved @lid sender as @lid end-to-end (no mapping known)', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '111@lid', fromMe: false, id: 'IN_LID_RAW' },
          message: { conversation: 'hi from unknown lid' },
          messageTimestamp: 1700000005,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { from: string; chatId: string; isLidSender?: boolean };
    expect(msg.from).toBe('111@lid'); // unresolved: kept as a privacy id, not faked into a phone
    expect(msg.chatId).toBe('111@lid');
    expect(msg.isLidSender).toBe(true);
  });

  it('routes a fromMe message to onMessageCreate (outgoing), not onMessage', async () => {
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageCreate });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'OUT2' },
          message: { conversation: 'sent from phone' },
          messageTimestamp: 1700000003,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores an append upsert with no/old timestamp (real history backfill)', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('connection.update', { connection: 'open' }); // sets connectedAt
    fakeSock.fire('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'OLD' },
          message: { conversation: 'old' },
          messageTimestamp: Math.floor(Date.now() / 1000) - 3600, // an hour before connectedAt
        },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('still processes an append upsert timestamped after this connection opened (reconnect edge case, #703)', async () => {
    // Baileys can tag a genuinely new message 'append' when it arrives in the same window as a
    // reconnect's state-sync handshake; only the message's own timestamp vs. connectedAt should
    // decide history vs. live, not the batch's type tag.
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('connection.update', { connection: 'open' }); // sets connectedAt
    fakeSock.fire('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'FRESH' },
          message: { conversation: 'hi right after reconnect' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalled();
  });

  it('does not double-fire onMessageCreate for a recent append echo of our own send', async () => {
    // Baileys echoes our own just-sent messages back through messages.upsert tagged 'append' too.
    // sendContent() already emits onMessageCreate for those via emitOwnSendEcho() (not exercised by
    // this fakeSock harness) — the recency override must stay scoped to fromMe !== true so this
    // path doesn't ALSO fire onMessageCreate a second time for the same send.
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageCreate });
    fakeSock.fire('connection.update', { connection: 'open' }); // sets connectedAt
    fakeSock.fire('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'OWN_ECHO' },
          message: { conversation: 'sent by us' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
  });

  it('emits onMessageAck from messages.update with a neutral status', async () => {
    const onMessageAck = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessageAck });
    fakeSock.fire('messages.update', [{ key: { id: 'OUT1' }, update: { status: 3 } }]);
    expect(onMessageAck).toHaveBeenCalledWith('OUT1', 'delivered');
  });

  it('inbound image: downloads media and exposes base64 + caption as body', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      getContentType: jest.Mock;
      downloadMediaMessage: jest.Mock;
    };
    baileys.getContentType.mockReturnValue('imageMessage');
    const imgBuf = Buffer.from('PNGBYTES');
    baileys.downloadMediaMessage.mockResolvedValue(streamOf(imgBuf));

    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IMG1' },
          message: { imageMessage: { mimetype: 'image/png', caption: 'look at this' } },
          messageTimestamp: 1700000020,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as {
      id: string;
      body: string;
      type: string;
      media: { mimetype: string; data: string };
    };
    expect(msg.type).toBe('image');
    expect(msg.body).toBe('look at this');
    expect(msg.media).toEqual({ mimetype: 'image/png', data: imgBuf.toString('base64') });
  });

  it('inbound media: skips the download entirely when the declared fileLength exceeds the cap', async () => {
    const prev = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '10';
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const baileys = jest.requireMock('@whiskeysockets/baileys') as {
        getContentType: jest.Mock;
        downloadMediaMessage: jest.Mock;
      };
      baileys.getContentType.mockReturnValue('documentMessage');
      baileys.downloadMediaMessage.mockClear();

      const onMessage = jest.fn();
      const adapter = newAdapter();
      await adapter.initialize({ onMessage });
      fakeSock.fire('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'BIG1' },
            message: { documentMessage: { mimetype: 'application/pdf', fileName: 'huge.pdf', fileLength: 1000 } },
            messageTimestamp: 1700000030,
          },
        ],
      });
      await new Promise(r => setImmediate(r));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msg = onMessage.mock.calls[0][0] as { media: { omitted?: boolean; data?: string; sizeBytes?: number } };
      expect(msg.media.omitted).toBe(true);
      expect(msg.media.data).toBeUndefined();
      expect(msg.media.sizeBytes).toBe(1000);
      expect(baileys.downloadMediaMessage).not.toHaveBeenCalled(); // over-cap media is never downloaded
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
      else process.env.MEDIA_DOWNLOAD_MAX_BYTES = prev;
    }
  });

  it('inbound media: aborts mid-download when the stream exceeds the cap (sender understated size)', async () => {
    const prev = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '10';
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const baileys = jest.requireMock('@whiskeysockets/baileys') as {
        getContentType: jest.Mock;
        downloadMediaMessage: jest.Mock;
      };
      baileys.getContentType.mockReturnValue('imageMessage');
      // No declared fileLength (passes the pre-gate), but the stream yields 18 bytes > the 10-byte cap.
      baileys.downloadMediaMessage.mockResolvedValue(streamOf(Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)));

      const onMessage = jest.fn();
      const adapter = newAdapter();
      await adapter.initialize({ onMessage });
      fakeSock.fire('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'LIAR1' },
            message: { imageMessage: { mimetype: 'image/png' } },
            messageTimestamp: 1700000031,
          },
        ],
      });
      await new Promise(r => setImmediate(r));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msg = onMessage.mock.calls[0][0] as { media: { omitted?: boolean; data?: string } };
      expect(msg.media.omitted).toBe(true);
      expect(msg.media.data).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
      else process.env.MEDIA_DOWNLOAD_MAX_BYTES = prev;
    }
  });

  it('inbound media: skips download and omits media field when MEDIA_DOWNLOAD_ENABLED=false', async () => {
    const prev = process.env.MEDIA_DOWNLOAD_ENABLED;
    process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const baileys = jest.requireMock('@whiskeysockets/baileys') as {
        getContentType: jest.Mock;
        downloadMediaMessage: jest.Mock;
      };
      baileys.getContentType.mockReturnValue('imageMessage');
      baileys.downloadMediaMessage.mockClear();

      const onMessage = jest.fn();
      const adapter = newAdapter();
      await adapter.initialize({ onMessage });
      fakeSock.fire('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'DISABLED1' },
            message: { imageMessage: { mimetype: 'image/png', caption: 'should not download' } },
            messageTimestamp: 1700000040,
          },
        ],
      });
      await new Promise(r => setImmediate(r));
      expect(onMessage).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msg = onMessage.mock.calls[0][0] as { media?: { omitted?: boolean; mimetype?: string }; type: string };
      expect(msg.type).toBe('image');
      expect(msg.media).toBeDefined();
      expect(msg.media?.omitted).toBe(true);
      expect(msg.media?.mimetype).toBe('image/png');
      expect(baileys.downloadMediaMessage).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DOWNLOAD_ENABLED;
      else process.env.MEDIA_DOWNLOAD_ENABLED = prev;
    }
  });

  it('inbound documentWithCaption: normalizeMessageContent unwraps wrapper, yields non-empty mimetype', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      getContentType: jest.Mock;
      downloadMediaMessage: jest.Mock;
      normalizeMessageContent: jest.Mock;
    };
    baileys.getContentType.mockReturnValue('documentWithCaptionMessage');
    const docBuf = Buffer.from('PDFBYTES');
    baileys.downloadMediaMessage.mockResolvedValue(streamOf(docBuf));
    // Simulate normalizeMessageContent unwrapping: returns the inner documentMessage.
    baileys.normalizeMessageContent.mockReturnValue({
      documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf', caption: 'Q1 report' },
    });

    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'DOC1' },
          message: {
            documentWithCaptionMessage: {
              message: {
                documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf', caption: 'Q1 report' },
              },
            },
          },
          messageTimestamp: 1700000030,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as {
      type: string;
      body: string;
      media: { mimetype: string; filename?: string; data: string };
    };
    expect(msg.type).toBe('document');
    // The caption rides under the unwrapped documentMessage; reading the raw wrapper would lose it.
    expect(msg.body).toBe('Q1 report');
    expect(msg.media.mimetype).toBe('application/pdf');
    expect(msg.media.filename).toBe('report.pdf');
    expect(msg.media.data).toBe(docBuf.toString('base64'));
  });

  it('extracts ephemeralDuration from an ephemeralMessage-wrapped inbound message (disappearing chat)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      getContentType: jest.Mock;
      normalizeMessageContent: jest.Mock;
    };
    // Mirror real Baileys: getContentType returns the OUTER key for a wrapped message ('ephemeralMessage')
    // and the inner key once normalized ('extendedTextMessage'). This forces the test through the
    // production normalize-then-getContentType path instead of a mock shortcut — if the adapter forgot to
    // normalize before reading the type/body, the assertions below would fail.
    baileys.getContentType.mockImplementation((m?: { ephemeralMessage?: unknown }) =>
      m?.ephemeralMessage ? 'ephemeralMessage' : 'extendedTextMessage',
    );
    // A live disappearing message arrives wrapped in `ephemeralMessage`; normalizeMessageContent unwraps
    // it to the inner content carrying the body and the timer on `contextInfo.expiration`. Reading the raw
    // (wrapped) content would miss both — the exact case this guards.
    baileys.normalizeMessageContent.mockReturnValue({
      extendedTextMessage: { text: 'vanishes', contextInfo: { expiration: 86400 } },
    });

    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'EPH1' },
          message: {
            ephemeralMessage: {
              message: { extendedTextMessage: { text: 'vanishes', contextInfo: { expiration: 86400 } } },
            },
          },
          messageTimestamp: 1700000040,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { type: string; body: string; ephemeralDuration?: number };
    // The body and type are derived from the normalized inner content, not the ephemeralMessage wrapper.
    expect(msg.type).toBe('text');
    expect(msg.body).toBe('vanishes');
    expect(msg.ephemeralDuration).toBe(86400);
  });

  it('wrapped voice note in a disappearing chat maps to type voice', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      getContentType: jest.Mock;
      normalizeMessageContent: jest.Mock;
    };
    baileys.getContentType.mockImplementation((m?: { ephemeralMessage?: unknown }) =>
      m?.ephemeralMessage ? 'ephemeralMessage' : 'audioMessage',
    );
    baileys.normalizeMessageContent.mockReturnValue({
      audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' },
    });

    const prev = process.env.MEDIA_DOWNLOAD_ENABLED;
    process.env.MEDIA_DOWNLOAD_ENABLED = 'false'; // omitted-marker path: no download mock needed
    try {
      const onMessage = jest.fn();
      const adapter = newAdapter();
      await adapter.initialize({ onMessage });
      fakeSock.fire('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'EPHVOICE1' },
            message: {
              ephemeralMessage: {
                message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
              },
            },
            messageTimestamp: 1700000041,
          },
        ],
      });
      await new Promise(r => setImmediate(r));
      expect(onMessage).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const msg = onMessage.mock.calls[0][0] as { type: string };
      expect(msg.type).toBe('voice');
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DOWNLOAD_ENABLED;
      else process.env.MEDIA_DOWNLOAD_ENABLED = prev;
    }
  });

  it('inbound location: populates the location field with coordinates', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValue('locationMessage');

    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'LOC1' },
          message: {
            locationMessage: {
              degreesLatitude: 1.23,
              degreesLongitude: 4.56,
              name: 'Office',
              address: '1 Main St',
            },
          },
          messageTimestamp: 1700000021,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as {
      type: string;
      location: { latitude: number; longitude: number; description?: string; address?: string };
    };
    expect(msg.type).toBe('location');
    expect(msg.location).toEqual({ latitude: 1.23, longitude: 4.56, description: 'Office', address: '1 Main St' });
  });

  it('inbound quoted reply: populates quotedMessage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValue('extendedTextMessage');

    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'REPLY1' },
          message: {
            extendedTextMessage: {
              text: 'reply text',
              contextInfo: {
                stanzaId: 'QUOTED_ID',
                quotedMessage: { conversation: 'original message' },
              },
            },
          },
          messageTimestamp: 1700000022,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as {
      body: string;
      quotedMessage: { id: string; body: string };
    };
    expect(msg.body).toBe('reply text');
    expect(msg.quotedMessage).toEqual({ id: 'QUOTED_ID', body: 'original message' });
  });

  it('REVOKE protocolMessage: fires onMessageRevoked and NOT onMessage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValue('protocolMessage');

    const onMessage = jest.fn();
    const onMessageRevoked = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageRevoked });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'PROTO1' },
          message: {
            protocolMessage: {
              key: { id: 'ORIGINAL_ID' },
              type: 0, // REVOKE
            },
          },
          messageTimestamp: 1700000023,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageRevoked).toHaveBeenCalledTimes(1);
    expect(fakeStore.put).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const revoked = onMessageRevoked.mock.calls[0][0] as {
      id: string;
      revokedId?: string;
      chatId: string;
      type: string;
      body: string;
    };
    expect(revoked.id).toBe('ORIGINAL_ID');
    // The REVOKE protocolMessage key IS the original, so revokedId mirrors id here.
    expect(revoked.revokedId).toBe('ORIGINAL_ID');
    expect(revoked.chatId).toBe('628111@c.us'); // canonicalized to the neutral dialect
    expect(revoked.type).toBe('revoked');
    expect(revoked.body).toBe('');
  });

  it('EDIT protocolMessage: fires onMessageEdited and NOT onMessage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValueOnce('protocolMessage').mockReturnValueOnce('conversation');

    const onMessage = jest.fn();
    const onMessageEdited = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageEdited });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '628111@s.whatsapp.net',
            participant: '628111@s.whatsapp.net',
            fromMe: false,
            id: 'PROTO_EDIT',
          },
          message: {
            protocolMessage: {
              key: { id: 'ORIGINAL_MSG_ID' },
              type: 14, // MESSAGE_EDIT
              timestampMs: 1700000030123,
              editedMessage: { conversation: 'New edited message text' },
            },
          },
          messageTimestamp: 1700000000,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageEdited).toHaveBeenCalledTimes(1);
    expect(fakeStore.put).not.toHaveBeenCalled();

    expect(firstEditedMessage(onMessageEdited)).toEqual({
      messageId: 'ORIGINAL_MSG_ID',
      chatId: '628111@c.us',
      body: 'New edited message text',
      senderId: '628111@c.us',
      from: '628111@c.us',
      to: '628999@c.us',
      fromMe: false,
      isGroup: false,
      type: 'text',
      hasMedia: false,
      timestamp: 1700000030,
    });
  });

  it('EDIT protocolMessage: extracts media caption correctly (e.g. image caption)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValueOnce('protocolMessage').mockReturnValueOnce('imageMessage');

    const onMessage = jest.fn();
    const onMessageEdited = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageEdited });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '628111@s.whatsapp.net',
            participant: '628111@s.whatsapp.net',
            fromMe: false,
            id: 'PROTO_EDIT_MEDIA',
          },
          message: {
            protocolMessage: {
              key: { id: 'ORIGINAL_MSG_ID' },
              type: 14, // MESSAGE_EDIT
              editedMessage: {
                imageMessage: { caption: 'Edited image caption text' },
              },
            },
          },
          messageTimestamp: 1700000035,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageEdited).toHaveBeenCalledTimes(1);

    const edited = firstEditedMessage(onMessageEdited);
    expect(edited.messageId).toBe('ORIGINAL_MSG_ID');
    expect(edited.chatId).toBe('628111@c.us');
    expect(edited.body).toBe('Edited image caption text');
    expect(edited.senderId).toBe('628111@c.us');
    expect(edited.timestamp).toBe(1700000035);
    expect(edited.type).toBe('image');
    expect(edited.hasMedia).toBe(true);
  });

  it('EDIT protocolMessage: correctly maps senderId for own outgoing edits (fromMe = true)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValueOnce('protocolMessage').mockReturnValueOnce('conversation');
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };

    const onMessage = jest.fn();
    const onMessageEdited = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageEdited });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: true, id: 'PROTO_EDIT_SELF' },
          message: {
            protocolMessage: {
              key: { id: 'ORIGINAL_MSG_ID' },
              type: 14, // MESSAGE_EDIT
              editedMessage: { conversation: 'Self-edited text' },
            },
          },
          messageTimestamp: 1700000040,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageEdited).toHaveBeenCalledTimes(1);

    const edited = firstEditedMessage(onMessageEdited);
    expect(edited.messageId).toBe('ORIGINAL_MSG_ID');
    expect(edited.chatId).toBe('628111@c.us');
    expect(edited.body).toBe('Self-edited text');
    expect(edited.senderId).toBe('628999@c.us');
    expect(edited.timestamp).toBe(1700000040);
    expect(edited.from).toBe('628999@c.us');
    expect(edited.to).toBe('628111@c.us');
    expect(edited.fromMe).toBe(true);
  });

  it('EDIT protocolMessage: normalizes group author and mentions for webhook filters', async () => {
    baileys.getContentType.mockReturnValueOnce('protocolMessage').mockReturnValueOnce('extendedTextMessage');
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };

    const onMessageEdited = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessageEdited });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '120363000@g.us',
            participant: '628111@s.whatsapp.net',
            fromMe: false,
            id: 'PROTO_EDIT_GROUP',
          },
          message: {
            protocolMessage: {
              key: { id: 'GROUP_MSG_ID' },
              type: 14,
              editedMessage: {
                extendedTextMessage: {
                  text: 'Hello @628222',
                  contextInfo: { mentionedJid: ['628222@s.whatsapp.net'] },
                },
              },
            },
          },
          messageTimestamp: 1700000045,
        },
      ],
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(firstEditedMessage(onMessageEdited)).toEqual(
      expect.objectContaining({
        chatId: '120363000@g.us',
        from: '120363000@g.us',
        to: '628999@c.us',
        senderId: '628111@c.us',
        author: '628111@c.us',
        mentionedIds: ['628222@c.us'],
        isGroup: true,
        type: 'text',
      }),
    );
  });

  it('reactionMessage: fires onMessageReaction and NOT onMessage', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };
    baileys.getContentType.mockReturnValue('reactionMessage');

    const onMessage = jest.fn();
    const onMessageReaction = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage, onMessageReaction });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '628111@s.whatsapp.net',
            fromMe: false,
            id: 'REACT1',
            participant: '628111@s.whatsapp.net',
          },
          message: {
            reactionMessage: {
              key: { id: 'TARGET_MSG_ID' },
              text: '👍',
            },
          },
          messageTimestamp: 1700000024,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageReaction).toHaveBeenCalledTimes(1);
    expect(fakeStore.put).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const event = onMessageReaction.mock.calls[0][0] as {
      messageId: string;
      chatId: string;
      reaction: string;
      senderId: string;
    };
    expect(event.messageId).toBe('TARGET_MSG_ID');
    expect(event.chatId).toBe('628111@c.us'); // canonicalized to the neutral dialect
    expect(event.reaction).toBe('👍');
    expect(event.senderId).toBe('628111@c.us'); // canonicalized to the neutral dialect
  });

  it('media download failure: logs the error and emits the message without media (no throw)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      getContentType: jest.Mock;
      downloadMediaMessage: jest.Mock;
    };
    baileys.getContentType.mockReturnValue('imageMessage');
    baileys.downloadMediaMessage.mockRejectedValue(new Error('download failed'));

    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IMGFAIL' },
          message: { imageMessage: { mimetype: 'image/jpeg', caption: 'broken' } },
          messageTimestamp: 1700000025,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // message is still emitted, just without media
    expect(onMessage).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { media?: unknown };
    expect(msg.media).toBeUndefined();
  });
});

describe('BaileysAdapter media sends', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1700000005 });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sendImageMessage sends a Buffer image with caption + mimetype', async () => {
    const adapter = await ready();
    const buf = Buffer.from([1, 2, 3]);
    const res = await adapter.sendImageMessage('628111@s.whatsapp.net', {
      mimetype: 'image/png',
      data: buf,
      caption: 'hi',
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      image: buf,
      caption: 'hi',
      mimetype: 'image/png',
    });
    expect(res).toEqual({ id: 'M1', timestamp: 1700000005 });
  });

  it('sendImageMessage de-normalizes media.mentions into the content (#530)', async () => {
    const adapter = await ready();
    await adapter.sendImageMessage('120@g.us', {
      mimetype: 'image/png',
      data: Buffer.from([1]),
      caption: 'look @62811',
      mentions: ['62811@c.us'],
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '120@g.us',
      expect.objectContaining({ mentions: ['62811@s.whatsapp.net'] }),
    );
  });

  it('resolves a base64 data string to a Buffer (no URL fetch)', async () => {
    const adapter = await ready();
    await adapter.sendDocumentMessage('628111@s.whatsapp.net', {
      mimetype: 'application/pdf',
      data: Buffer.from('PDFDATA').toString('base64'),
      filename: 'doc.pdf',
      caption: 'a document',
    });
    expect(loadRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      document: Buffer.from('PDFDATA'),
      mimetype: 'application/pdf',
      fileName: 'doc.pdf',
      caption: 'a document',
    });
  });

  it('fetches a URL data string through the SSRF-guarded loader', async () => {
    (loadRemoteMediaBuffer as jest.Mock).mockResolvedValue({ data: Buffer.from([9]), mimetype: 'video/mp4' });
    const adapter = await ready();
    await adapter.sendVideoMessage('628111@s.whatsapp.net', { mimetype: '', data: 'https://cdn.example/v.mp4' });
    expect(loadRemoteMediaBuffer).toHaveBeenCalledWith('https://cdn.example/v.mp4');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      video: Buffer.from([9]),
      caption: undefined,
      mimetype: 'video/mp4',
    });
  });

  it('sendAudioMessage sets ptt:false', async () => {
    const adapter = await ready();
    await adapter.sendAudioMessage('628111@s.whatsapp.net', { mimetype: 'audio/mp4', data: Buffer.from([1]) });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      audio: Buffer.from([1]),
      mimetype: 'audio/mp4',
      ptt: false,
    });
  });

  it('sendAudioMessage with ptt sends a voice note (ptt:true)', async () => {
    const adapter = await ready();
    await adapter.sendAudioMessage('628111@s.whatsapp.net', {
      mimetype: 'audio/ogg; codecs=opus',
      data: Buffer.from([1]),
      ptt: true,
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      audio: Buffer.from([1]),
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
  });

  it('sendStickerMessage sends the sticker buffer', async () => {
    const adapter = await ready();
    await adapter.sendStickerMessage('628111@s.whatsapp.net', { mimetype: 'image/webp', data: Buffer.from([7]) });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { sticker: Buffer.from([7]) });
  });

  it('uses the caller-declared mimetype over the fetched content-type for a URL', async () => {
    (loadRemoteMediaBuffer as jest.Mock).mockResolvedValue({
      data: Buffer.from([1]),
      mimetype: 'application/octet-stream',
    });
    const adapter = await ready();
    await adapter.sendImageMessage('628111@s.whatsapp.net', { mimetype: 'image/png', data: 'https://cdn.example/x' });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      image: Buffer.from([1]),
      caption: undefined,
      mimetype: 'image/png',
    });
  });

  it('media sends reject with EngineNotReadyError before the connection is open', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(
      adapter.sendImageMessage('x', { mimetype: 'image/png', data: Buffer.from([1]) }),
    ).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter store-backed ops', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({
      key: { id: 'OUT', remoteJid: '628111@s.whatsapp.net', fromMe: true },
      messageTimestamp: 1700000009,
    });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  const stored = {
    key: { id: 'TARGET', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'hi' },
  };

  // An outbound (own) variant of `stored` — editMessage refuses inbound keys, so its happy-path
  // tests must store a fromMe: true message.
  const ownStored = {
    key: { id: 'TARGET', remoteJid: '628111@s.whatsapp.net', fromMe: true },
    message: { conversation: 'hi' },
  };

  it('replyToMessage quotes the stored message', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.replyToMessage('628111@s.whatsapp.net', 'TARGET', 'my reply');
    expect(fakeStore.getMessage).toHaveBeenCalledWith('db-uuid-1', 'TARGET');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      { text: 'my reply' },
      { quoted: stored },
    );
  });

  it('forwardMessage forwards the stored message', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.forwardMessage('628111@s.whatsapp.net', '628222@s.whatsapp.net', 'TARGET');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628222@s.whatsapp.net', { forward: stored });
  });

  it('reactToMessage sends the stored key', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.reactToMessage('628111@s.whatsapp.net', 'TARGET', '👍');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      react: { text: '👍', key: stored.key },
    });
  });

  it("starMessage carries the stored key's fromMe, not just the id", async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.starMessage('628111@s.whatsapp.net', 'TARGET', true);
    // The same id addresses a different message depending on direction, so dropping fromMe would
    // star the wrong side of the conversation.
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      { star: { messages: [{ id: stored.key.id, fromMe: stored.key.fromMe ?? false }], star: true } },
      '628111@s.whatsapp.net',
    );
  });

  it('starMessage passes star:false through for an unstar', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.starMessage('628111@s.whatsapp.net', 'TARGET', false);
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      { star: { messages: [{ id: stored.key.id, fromMe: stored.key.fromMe ?? false }], star: false } },
      '628111@s.whatsapp.net',
    );
  });

  it('votePoll is an honest 501 — Baileys has no vote-send helper, only decryptPollVote', async () => {
    const adapter = await ready();
    await expect(adapter.votePoll('628111@s.whatsapp.net', 'P1', ['Pizza'])).rejects.toBeInstanceOf(
      EngineNotSupportedError,
    );
  });

  it('pinMessage pins IN CHAT via the stored key, with the requested window', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.pinMessage('628111@s.whatsapp.net', 'TARGET', 604800);
    // PIN_FOR_ALL (1) on a sendMessage — NOT chatModify({pin}), which pins the CHAT in the chat
    // list. The two are entirely different features that happen to share the word "pin".
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      pin: stored.key,
      type: 1,
      time: 604800,
    });
    expect(fakeSock.chatModify).not.toHaveBeenCalled();
  });

  it('unpinMessage sends UNPIN_FOR_ALL and omits the meaningless duration', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.unpinMessage('628111@s.whatsapp.net', 'TARGET');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      pin: stored.key,
      type: 2,
    });
  });

  it('pinMessage 404s when the message is not in the store', async () => {
    fakeStore.getMessage.mockResolvedValue(undefined);
    const adapter = await ready();
    await expect(adapter.pinMessage('628111@s.whatsapp.net', 'GONE', 86400)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('deleteMessage revokes via the stored key', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.deleteMessage('628111@s.whatsapp.net', 'TARGET', true);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { delete: stored.key });
  });

  it('media sends honor the chat disappearing timer via the funnel (#473)', async () => {
    const adapter = await ready();
    fakeSock.fire('chats.upsert', [{ id: '628111@s.whatsapp.net', ephemeralExpiration: 86400 }]);
    await adapter.sendImageMessage('628111@s.whatsapp.net', { mimetype: 'image/png', data: Buffer.from([1]) });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      expect.objectContaining({ image: Buffer.from([1]) }),
      { ephemeralExpiration: 86400 },
    );
  });

  it('replyToMessage merges the disappearing timer with the quoted option (#473)', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    fakeSock.fire('chats.upsert', [{ id: '628111@s.whatsapp.net', ephemeralExpiration: 604800 }]);
    await adapter.replyToMessage('628111@s.whatsapp.net', 'TARGET', 'my reply');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      { text: 'my reply' },
      { quoted: stored, ephemeralExpiration: 604800 },
    );
  });

  it('react and delete never carry an ephemeral timer (Baileys does not exclude reactions) (#473)', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    fakeSock.fire('chats.upsert', [{ id: '628111@s.whatsapp.net', ephemeralExpiration: 604800 }]);
    await adapter.reactToMessage('628111@s.whatsapp.net', 'TARGET', '👍');
    await adapter.deleteMessage('628111@s.whatsapp.net', 'TARGET', true);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      react: { text: '👍', key: stored.key },
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { delete: stored.key });
  });

  it('throws when the referenced message is not in the store', async () => {
    fakeStore.getMessage.mockResolvedValue(null);
    const adapter = await ready();
    await expect(adapter.replyToMessage('c', 'GONE', 'x')).rejects.toThrow(/not found/i);
  });

  it('deleteMessage for-me (forEveryone=false) deletes via chatModify({ deleteForMe })', async () => {
    fakeStore.getMessage.mockResolvedValue({ ...stored, messageTimestamp: 1700000007 });
    const adapter = await ready();
    await adapter.deleteMessage('628111@s.whatsapp.net', 'TARGET', false);
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      { deleteForMe: { deleteMedia: true, key: stored.key, timestamp: 1700000007 } },
      '628111@s.whatsapp.net',
    );
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });

  it('editMessage edits via the stored key and returns the (unchanged) message id', async () => {
    fakeStore.getMessage.mockResolvedValue(ownStored);
    fakeSock.sendMessage.mockResolvedValue({ key: { ...ownStored.key }, messageTimestamp: 1700000010 });
    const adapter = await ready();
    const res = await adapter.editMessage('628111@s.whatsapp.net', 'TARGET', 'edited body');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      text: 'edited body',
      edit: ownStored.key,
    });
    expect(res).toEqual({ id: 'TARGET', timestamp: 1700000010 });
  });

  it('editMessage falls back to the requested id when the send echoes nothing back', async () => {
    fakeStore.getMessage.mockResolvedValue(ownStored);
    fakeSock.sendMessage.mockResolvedValue(undefined);
    const adapter = await ready();
    const res = await adapter.editMessage('628111@s.whatsapp.net', 'TARGET', 'edited body');
    expect(res.id).toBe('TARGET');
  });

  it('editMessage throws MessageNotFoundError when the message is not in the store', async () => {
    fakeStore.getMessage.mockResolvedValue(null);
    const adapter = await ready();
    await expect(adapter.editMessage('628111@s.whatsapp.net', 'GONE', 'x')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });

  it('editMessage refuses an inbound (not own) message with EngineRefusedError (403), no send', async () => {
    fakeStore.getMessage.mockResolvedValue(stored); // the shared fixture is fromMe: false
    const adapter = await ready();
    await expect(adapter.editMessage('628111@s.whatsapp.net', 'TARGET', 'x')).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });

  it('editMessage throws MessageNotFoundError when the stored key belongs to another chat', async () => {
    fakeStore.getMessage.mockResolvedValue({
      ...ownStored,
      key: { ...ownStored.key, remoteJid: '628222@s.whatsapp.net' },
    });
    const adapter = await ready();
    await expect(adapter.editMessage('628111@s.whatsapp.net', 'TARGET', 'x')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });

  it('editMessage matches the chat across dialects (@c.us request vs @s.whatsapp.net stored key)', async () => {
    fakeStore.getMessage.mockResolvedValue(ownStored);
    fakeSock.sendMessage.mockResolvedValue(undefined);
    const adapter = await ready();
    await expect(adapter.editMessage('628111@c.us', 'TARGET', 'x')).resolves.toBeDefined();
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@c.us', { text: 'x', edit: ownStored.key });
  });

  it('editMessage sends to the LID-resolved deliverable jid (463 tctoken fix, same as the send path)', async () => {
    fakeStore.getMessage.mockResolvedValue(ownStored);
    fakeSock.sendMessage.mockResolvedValue(undefined);
    fakeSock.signalRepository = { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue('484848@lid') } };
    const adapter = await ready();
    await adapter.editMessage('628111@c.us', 'TARGET', 'edited body');
    expect(fakeSock.signalRepository.lidMapping.getLIDForPN).toHaveBeenCalledWith('628111@s.whatsapp.net');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('484848@lid', { text: 'edited body', edit: ownStored.key });
  });

  it('addLabelToChat wires 1:1 to sock.addChatLabel(chatId, labelId)', async () => {
    const adapter = await ready();
    await adapter.addLabelToChat('628111@s.whatsapp.net', 'LABEL8');
    expect(fakeSock.addChatLabel).toHaveBeenCalledWith('628111@s.whatsapp.net', 'LABEL8');
  });

  it('removeLabelFromChat wires 1:1 to sock.removeChatLabel(chatId, labelId)', async () => {
    const adapter = await ready();
    await adapter.removeLabelFromChat('628111@s.whatsapp.net', 'LABEL8');
    expect(fakeSock.removeChatLabel).toHaveBeenCalledWith('628111@s.whatsapp.net', 'LABEL8');
  });

  // chatModify keys the label app-state index by the RAW jid, so a neutral @c.us would label a
  // phantom chat the phone never reads — reported as success. Same fold the deleteForMe/star
  // writes carry.
  it('addLabelToChat folds the neutral @c.us id to the engine form', async () => {
    const adapter = await ready();
    await adapter.addLabelToChat('628111@c.us', 'LABEL8');
    expect(fakeSock.addChatLabel).toHaveBeenCalledWith('628111@s.whatsapp.net', 'LABEL8');
  });

  it('removeLabelFromChat folds the neutral @c.us id to the engine form', async () => {
    const adapter = await ready();
    await adapter.removeLabelFromChat('628111@c.us', 'LABEL8');
    expect(fakeSock.removeChatLabel).toHaveBeenCalledWith('628111@s.whatsapp.net', 'LABEL8');
  });

  // A stored key must belong to the requested chat: the pin/star/react/delete would otherwise land
  // in whatever chat the caller named while referencing another conversation's message — and
  // report success. editMessage has carried this guard from the start; these are its siblings.
  it.each([
    ['starMessage', (a: BaileysAdapter) => a.starMessage('628999@c.us', 'TARGET', true)],
    ['pinMessage', (a: BaileysAdapter) => a.pinMessage('628999@c.us', 'TARGET', 86400)],
    ['unpinMessage', (a: BaileysAdapter) => a.unpinMessage('628999@c.us', 'TARGET')],
    ['reactToMessage', (a: BaileysAdapter) => a.reactToMessage('628999@c.us', 'TARGET', '👍')],
    ['deleteMessage', (a: BaileysAdapter) => a.deleteMessage('628999@c.us', 'TARGET', true)],
  ])('%s refuses a chat/message pair mismatch as not-found', async (_name, call) => {
    fakeStore.getMessage.mockResolvedValue(stored); // stored under 628111, requested for 628999
    const adapter = await ready();
    await expect(call(adapter)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
    expect(fakeSock.chatModify).not.toHaveBeenCalled();
  });

  it('pinMessage resolves the LID deliverable jid like the send path', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    fakeSock.signalRepository = { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue('484848@lid') } };
    const adapter = await ready();
    await adapter.pinMessage('628111@c.us', 'TARGET', 86400);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('484848@lid', expect.objectContaining({ pin: stored.key }));
  });

  it('getChannelById maps newsletterMetadata(jid) → Channel (optionals only when present)', async () => {
    fakeSock.newsletterMetadata.mockResolvedValue({
      id: '120363N@newsletter',
      name: 'Announcements',
      description: 'News',
      invite: 'ABC123',
      subscribers: 421,
      picture: { url: 'https://x/p.png' },
      verification: 'VERIFIED',
      creation_time: 1700000000,
    });
    const adapter = await ready();
    const channel = await adapter.getChannelById('120363N@newsletter');
    expect(fakeSock.newsletterMetadata).toHaveBeenCalledWith('jid', '120363N@newsletter');
    expect(channel).toEqual({
      id: '120363N@newsletter',
      name: 'Announcements',
      description: 'News',
      inviteCode: 'ABC123',
      subscriberCount: 421,
      picture: 'https://x/p.png',
      verified: true,
      createdAt: 1700000000,
    });
  });

  it('getChannelById returns null when newsletterMetadata resolves null', async () => {
    fakeSock.newsletterMetadata.mockResolvedValue(null);
    const adapter = await ready();
    expect(await adapter.getChannelById('unknown@newsletter')).toBeNull();
  });

  it('subscribeToChannel resolves invite→jid via newsletterMetadata then follows', async () => {
    fakeSock.newsletterMetadata.mockResolvedValue({ id: '120363S@newsletter', name: 'Solo', invite: 'CODE1' });
    const adapter = await ready();
    const channel = await adapter.subscribeToChannel('CODE1');
    expect(fakeSock.newsletterMetadata).toHaveBeenCalledWith('invite', 'CODE1');
    expect(fakeSock.newsletterFollow).toHaveBeenCalledWith('120363S@newsletter');
    expect(channel).toEqual({ id: '120363S@newsletter', name: 'Solo', inviteCode: 'CODE1' });
  });

  it('subscribeToChannel throws ChannelNotFoundError when the invite resolves null', async () => {
    fakeSock.newsletterMetadata.mockResolvedValue(null);
    const adapter = await ready();
    await expect(adapter.subscribeToChannel('BADCODE')).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it('unsubscribeFromChannel wires 1:1 to sock.newsletterUnfollow(channelId)', async () => {
    const adapter = await ready();
    await adapter.unsubscribeFromChannel('120363U@newsletter');
    expect(fakeSock.newsletterUnfollow).toHaveBeenCalledWith('120363U@newsletter');
  });

  it('getChannelMessages remains unsupported (raw BinaryNode — no library parser)', async () => {
    const adapter = await ready();
    await expect(adapter.getChannelMessages('120363M@newsletter', 10)).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  it('populates the store on an inbound message', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'IN9' }, message: { conversation: 'hi' } },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const inboundMatcher = expect.objectContaining({ key: expect.objectContaining({ id: 'IN9' }) });
    expect(fakeStore.put).toHaveBeenCalledWith('db-uuid-1', inboundMatcher);
  });

  it('populates the store on an outgoing send', async () => {
    const adapter = await ready();
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const outboundMatcher = expect.objectContaining({ key: expect.objectContaining({ id: 'OUT' }) });
    expect(fakeStore.put).toHaveBeenCalledWith('db-uuid-1', outboundMatcher);
  });

  it('clears the store on logout', async () => {
    const adapter = await ready();
    await adapter.logout();
    expect(fakeStore.clearSession).toHaveBeenCalledWith('db-uuid-1');
  });
});

describe('BaileysAdapter group management', () => {
  const META = {
    id: '123-456@g.us',
    subject: 'G',
    participants: [{ id: '628999@s.whatsapp.net', admin: 'superadmin' }],
  };

  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('getGroups maps groupFetchAllParticipating', async () => {
    fakeSock.groupFetchAllParticipating.mockResolvedValue({ '123-456@g.us': META });
    const adapter = await ready();
    const groups = await adapter.getGroups();
    expect(groups).toEqual([
      { id: '123-456@g.us', name: 'G', participantsCount: 1, isAdmin: true, linkedParentJID: null },
    ]);
  });

  it('getGroupInfo maps groupMetadata, and returns null only for a server refusal (401/403/404)', async () => {
    fakeSock.groupMetadata.mockResolvedValueOnce(META);
    const adapter = await ready();
    expect((await adapter.getGroupInfo('123-456@g.us'))?.id).toBe('123-456@g.us');
    // Baileys carries a server refusal as Boom with the numeric WA code on `data`
    // (assertNodeErrorFree, WABinary/generic-utils.js:57).
    fakeSock.groupMetadata.mockRejectedValueOnce(Object.assign(new Error('item-not-found'), { data: 404 }));
    expect(await adapter.getGroupInfo('x@g.us')).toBeNull();
    fakeSock.groupMetadata.mockRejectedValueOnce(Object.assign(new Error('not-authorized'), { data: 401 }));
    expect(await adapter.getGroupInfo('y@g.us')).toBeNull();
  });

  it('getGroupInfo does NOT fold a transport death into null — a dead socket is not "group not found"', async () => {
    const adapter = await ready();
    // Local Boom, no server error node: DisconnectReason-shaped 428 Connection Closed.
    const connectionClosed = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    fakeSock.groupMetadata.mockRejectedValueOnce(connectionClosed);
    await expect(adapter.getGroupInfo('123-456@g.us')).rejects.toBe(connectionClosed);
    // A non-boom failure (programming/protocol error) propagates too.
    fakeSock.groupMetadata.mockRejectedValueOnce(new Error('unexpected'));
    await expect(adapter.getGroupInfo('123-456@g.us')).rejects.toThrow('unexpected');
  });

  it('getGroupInfo canonicalizes participant + owner ids through the session store (lid -> phone)', async () => {
    const adapter = await ready();
    // History sync supplies the lid -> phone mapping; the adapter passes the store's canonicalizer in.
    fakeSock.fire('messaging-history.set', { lidPnMappings: [{ lid: '111@lid', pn: '628111@s.whatsapp.net' }] });
    fakeSock.groupMetadata.mockResolvedValueOnce({
      id: '123-456@g.us',
      subject: 'G',
      owner: '111@lid',
      participants: [
        { id: '111@lid', admin: 'superadmin' },
        { id: '222@lid', admin: null },
      ],
    });
    const info = await adapter.getGroupInfo('123-456@g.us');
    // Owner + the known admin fold to <phone>@c.us, so they share the dialect of canonicalized authors.
    expect(info?.owner).toBe('628111@c.us');
    expect(info?.participants[0]).toMatchObject({ id: '628111@c.us', number: '628111', isSuperAdmin: true });
    expect(info?.participants[1]).toMatchObject({ id: '222@lid', number: '222' }); // unresolved kept raw
  });

  it('createGroup returns the mapped new group', async () => {
    fakeSock.groupCreate.mockResolvedValue(META);
    const adapter = await ready();
    const g = await adapter.createGroup('G', ['628111@s.whatsapp.net']);
    expect(fakeSock.groupCreate).toHaveBeenCalledWith('G', ['628111@s.whatsapp.net']);
    expect(g.id).toBe('123-456@g.us');
  });

  it.each([
    ['addParticipants', 'add'],
    ['removeParticipants', 'remove'],
    ['promoteParticipants', 'promote'],
    ['demoteParticipants', 'demote'],
  ])('%s calls groupParticipantsUpdate with %s', async (method, action) => {
    const adapter = await ready();
    await (adapter as unknown as Record<string, (g: string, p: string[]) => Promise<void>>)[method]('123-456@g.us', [
      '628111@s.whatsapp.net',
    ]);
    expect(fakeSock.groupParticipantsUpdate).toHaveBeenCalledWith('123-456@g.us', ['628111@s.whatsapp.net'], action);
  });

  // A neutral `<phone>@c.us` participant id must reach Baileys as `<phone>@s.whatsapp.net` — only the
  // latter encodes to the single-byte protocol token; a raw `c.us` server suffix goes on the wire as an
  // unknown 4-byte string. The group id (`@g.us`) and `@lid` (a first-class addressing mode) are untouched.
  it.each([
    ['addParticipants', 'add'],
    ['removeParticipants', 'remove'],
    ['promoteParticipants', 'promote'],
    ['demoteParticipants', 'demote'],
  ])('%s folds a neutral @c.us participant id to the engine dialect on the wire', async (method, action) => {
    const adapter = await ready();
    await (adapter as unknown as Record<string, (g: string, p: string[]) => Promise<void>>)[method]('123-456@g.us', [
      '628111@c.us',
    ]);
    expect(fakeSock.groupParticipantsUpdate).toHaveBeenCalledWith('123-456@g.us', ['628111@s.whatsapp.net'], action);
  });

  it('participant ops pass @lid ids through unchanged (lid addressing mode)', async () => {
    const adapter = await ready();
    await adapter.addParticipants('123-456@g.us', ['111@lid']);
    expect(fakeSock.groupParticipantsUpdate).toHaveBeenCalledWith('123-456@g.us', ['111@lid'], 'add');
  });

  it('createGroup folds neutral @c.us participants to the engine dialect, keeping @lid raw', async () => {
    fakeSock.groupCreate.mockResolvedValue(META);
    const adapter = await ready();
    await adapter.createGroup('G', ['628111@c.us', '222@lid']);
    expect(fakeSock.groupCreate).toHaveBeenCalledWith('G', ['628111@s.whatsapp.net', '222@lid']);
  });

  it('leaveGroup / setGroupSubject / setGroupDescription delegate to the socket', async () => {
    const adapter = await ready();
    await adapter.leaveGroup('123-456@g.us');
    expect(fakeSock.groupLeave).toHaveBeenCalledWith('123-456@g.us');
    await adapter.setGroupSubject('123-456@g.us', 'New');
    expect(fakeSock.groupUpdateSubject).toHaveBeenCalledWith('123-456@g.us', 'New');
    await adapter.setGroupDescription('123-456@g.us', 'Desc');
    expect(fakeSock.groupUpdateDescription).toHaveBeenCalledWith('123-456@g.us', 'Desc');
  });

  it('getGroupInviteCode / revokeGroupInviteCode return the code', async () => {
    fakeSock.groupInviteCode.mockResolvedValue('ABC123');
    fakeSock.groupRevokeInvite.mockResolvedValue('NEW456');
    const adapter = await ready();
    expect(await adapter.getGroupInviteCode('123-456@g.us')).toBe('ABC123');
    expect(await adapter.revokeGroupInviteCode('123-456@g.us')).toBe('NEW456');
  });

  it('joinGroupViaInviteCode returns the joined group id (neutral dialect)', async () => {
    fakeSock.groupAcceptInvite.mockResolvedValue('120363000@g.us');
    const adapter = await ready();
    await expect(adapter.joinGroupViaInviteCode('CODE123')).resolves.toBe('120363000@g.us');
    expect(fakeSock.groupAcceptInvite).toHaveBeenCalledWith('CODE123');
  });

  it('joinGroupViaInviteCode throws InvalidInviteCodeError (400) when Baileys resolves undefined', async () => {
    // Baileys' groupAcceptInvite resolves undefined for an invalid/expired/revoked invite.
    fakeSock.groupAcceptInvite.mockResolvedValue(undefined);
    const adapter = await ready();
    const err = await adapter.joinGroupViaInviteCode('BAD').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidInviteCodeError);
    expect((err as Error).message).toMatch(/invalid, expired, or revoked/);
  });

  it('joinGroupViaInviteCode maps an IQ error to InvalidInviteCodeError (400)', async () => {
    // A rejected groupAcceptInvite (not-authorized / gone IQ) is the same client-facing cause.
    // Baileys carries the refusal as Boom with the numeric WA code on `data`.
    fakeSock.groupAcceptInvite.mockRejectedValue(Object.assign(new Error('not-authorized'), { data: 401 }));
    const adapter = await ready();
    await expect(adapter.joinGroupViaInviteCode('BAD')).rejects.toBeInstanceOf(InvalidInviteCodeError);
  });

  it('joinGroupViaInviteCode does NOT fold a transport death into a 400 — a dead socket is not a bad invite', async () => {
    // Local Boom, no server error node: DisconnectReason-shaped 428 Connection Closed.
    const connectionClosed = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    fakeSock.groupAcceptInvite.mockRejectedValue(connectionClosed);
    const adapter = await ready();
    await expect(adapter.joinGroupViaInviteCode('CODE123')).rejects.toBe(connectionClosed);
  });

  it('getGroupJoinInfo maps the preview fields, neutralizing ids', async () => {
    fakeSock.groupGetInviteInfo.mockResolvedValue({
      id: '120363000@g.us',
      subject: 'Preview me',
      desc: 'About us',
      owner: '628111@s.whatsapp.net',
      creation: 1720000000,
      size: 12,
    });
    const adapter = await ready();
    await expect(adapter.getGroupJoinInfo('CODE123')).resolves.toEqual({
      id: '120363000@g.us',
      name: 'Preview me',
      description: 'About us',
      owner: '628111@c.us',
      createdAt: 1720000000,
      participantCount: 12,
    });
  });

  it('getGroupJoinInfo maps a refused invite to GroupNotFoundError (404), not a raw Boom 500', async () => {
    // The vendored extractGroupMetadata throws a Boom carrying the WA code for an invalid/expired
    // invite; whatsapp-web.js answers the same cause with a 404, and the route documents 404.
    fakeSock.groupGetInviteInfo.mockRejectedValue(Object.assign(new Error('item-not-found'), { data: 404 }));
    const adapter = await ready();
    await expect(adapter.getGroupJoinInfo('BAD')).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('getGroupJoinInfo lets a transport death propagate — a dead socket is not a bad invite', async () => {
    const connectionClosed = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    fakeSock.groupGetInviteInfo.mockRejectedValue(connectionClosed);
    const adapter = await ready();
    await expect(adapter.getGroupJoinInfo('CODE123')).rejects.toBe(connectionClosed);
  });

  // The raw Boom used to escape as a 500 on every admin-refused group write, while the controller
  // documents 403 and the whatsapp-web.js adapter answers 403 for the same causes.
  it.each([
    ['setGroupSubject', (a: BaileysAdapter) => a.setGroupSubject('123-456@g.us', 'X'), 'groupUpdateSubject'],
    [
      'setGroupDescription',
      (a: BaileysAdapter) => a.setGroupDescription('123-456@g.us', 'X'),
      'groupUpdateDescription',
    ],
    [
      'setGroupMessagesAdminsOnly',
      (a: BaileysAdapter) => a.setGroupMessagesAdminsOnly('123-456@g.us', true),
      'groupSettingUpdate',
    ],
    [
      'setGroupInfoAdminsOnly',
      (a: BaileysAdapter) => a.setGroupInfoAdminsOnly('123-456@g.us', true),
      'groupSettingUpdate',
    ],
    ['deleteGroupPicture', (a: BaileysAdapter) => a.deleteGroupPicture('123-456@g.us'), 'removeProfilePicture'],
    [
      'setGroupMemberAddMode',
      (a: BaileysAdapter) => a.setGroupMemberAddMode('123-456@g.us', 'admins'),
      'groupMemberAddMode',
    ],
  ])('%s maps an admin-refused write to EngineRefusedError (403)', async (_name, call, sockMethod) => {
    (fakeSock as unknown as Record<string, jest.Mock>)[sockMethod].mockRejectedValueOnce(
      Object.assign(new Error('not-authorized'), { data: 401 }),
    );
    const adapter = await ready();
    await expect(call(adapter)).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('a transport death on a group write propagates untouched — not folded into a 403', async () => {
    const connectionClosed = Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });
    fakeSock.groupUpdateSubject.mockRejectedValueOnce(connectionClosed);
    const adapter = await ready();
    await expect(adapter.setGroupSubject('123-456@g.us', 'X')).rejects.toBe(connectionClosed);
  });

  it('addParticipants maps the per-participant [{status, jid}] array — a partial refusal does not throw', async () => {
    fakeSock.groupParticipantsUpdate.mockResolvedValueOnce([
      { status: '200', jid: '628111@s.whatsapp.net', content: {} },
      { status: '403', jid: '628222@s.whatsapp.net', content: {} },
      { status: '409', jid: '628333@s.whatsapp.net', content: {} },
    ]);
    const adapter = await ready();
    const results = await adapter.addParticipants('123-456@g.us', ['628111@c.us', '628222@c.us', '628333@c.us']);
    // Jids cross the engine boundary back in the neutral dialect; only the 200 entry is a success.
    expect(results).toEqual([
      { id: '628111@c.us', success: true, status: 200 },
      { id: '628222@c.us', success: false, status: 403 },
      { id: '628333@c.us', success: false, status: 409 },
    ]);
  });

  it.each([
    ['addParticipants', 'add'],
    ['removeParticipants', 'remove'],
    ['promoteParticipants', 'promote'],
    ['demoteParticipants', 'demote'],
  ])('%s throws EngineRefusedError (403) when EVERY participant is refused (e.g. not admin)', async method => {
    fakeSock.groupParticipantsUpdate.mockResolvedValueOnce([
      { status: '403', jid: '628111@s.whatsapp.net', content: {} },
      { status: '403', jid: '628222@s.whatsapp.net', content: {} },
    ]);
    const adapter = await ready();
    const err = await (adapter as unknown as Record<string, (g: string, p: string[]) => Promise<unknown>>)
      [method]('123-456@g.us', ['628111@c.us', '628222@c.us'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRefusedError);
    expect((err as Error).message).toMatch(/failed for all 2 participant/);
  });

  it('removeParticipants throws EngineRefusedError when the server returns no per-participant outcome', async () => {
    // An empty result is no evidence of success — reporting one would be a false success.
    fakeSock.groupParticipantsUpdate.mockResolvedValueOnce([]);
    const adapter = await ready();
    await expect(adapter.removeParticipants('123-456@g.us', ['628111@c.us'])).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it.each([
    ['setGroupMessagesAdminsOnly', true, 'announcement'],
    ['setGroupMessagesAdminsOnly', false, 'not_announcement'],
    ['setGroupInfoAdminsOnly', true, 'locked'],
    ['setGroupInfoAdminsOnly', false, 'unlocked'],
  ])('%s(%s) maps to groupSettingUpdate %s', async (method, value, setting) => {
    const adapter = await ready();
    await (adapter as unknown as Record<string, (g: string, v: boolean) => Promise<void>>)[method](
      '123-456@g.us',
      value,
    );
    expect(fakeSock.groupSettingUpdate).toHaveBeenCalledWith('123-456@g.us', setting);
  });

  it('setGroupEphemeral delegates to groupToggleEphemeral (0 disables)', async () => {
    const adapter = await ready();
    await adapter.setGroupEphemeral('123-456@g.us', 86400);
    expect(fakeSock.groupToggleEphemeral).toHaveBeenCalledWith('123-456@g.us', 86400);
    await adapter.setGroupEphemeral('123-456@g.us', 0);
    expect(fakeSock.groupToggleEphemeral).toHaveBeenCalledWith('123-456@g.us', 0);
  });

  it('getGroupInfo populates announce/locked/ephemeralSeconds from the metadata', async () => {
    fakeSock.groupMetadata.mockResolvedValueOnce({
      ...META,
      announce: true,
      restrict: true,
      ephemeralDuration: 7776000,
    });
    const adapter = await ready();
    const info = await adapter.getGroupInfo('123-456@g.us');
    expect(info?.announce).toBe(true);
    expect(info?.locked).toBe(true);
    expect(info?.ephemeralSeconds).toBe(7776000);
  });

  it('setProfileName / setProfileStatus delegate to the socket', async () => {
    const adapter = await ready();
    await adapter.setProfileName('New Name');
    expect(fakeSock.updateProfileName).toHaveBeenCalledWith('New Name');
    await adapter.setProfileStatus('about text');
    expect(fakeSock.updateProfileStatus).toHaveBeenCalledWith('about text');
  });

  it('setProfilePicture resolves the media and uploads it under the own JID (device suffix stripped)', async () => {
    // fakeSock.user.id is '628999:1@s.whatsapp.net' (see beforeEach) — the own JID the adapter
    // normalizes the same way as everywhere else.
    const adapter = await ready();
    await adapter.setProfilePicture({ mimetype: 'image/png', data: Buffer.from('IMG').toString('base64') });
    expect(fakeSock.updateProfilePicture).toHaveBeenCalledWith('628999@s.whatsapp.net', Buffer.from('IMG'));
  });

  it('setProfilePicture throws when the own JID is not known', async () => {
    fakeSock.user = undefined;
    const adapter = await ready();
    await expect(adapter.setProfilePicture({ mimetype: 'image/png', data: 'AAAA' })).rejects.toThrow(/own JID/);
  });

  it('group ops reject with EngineNotReadyError before connect', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter group events (group-participants.update / groups.update)', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyWithGroupEvents = async (): Promise<{ onGroupEvent: jest.Mock }> => {
    const onGroupEvent = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onGroupEvent }));
    fakeSock.fire('connection.update', { connection: 'open' });
    return { onGroupEvent };
  };

  const firstEvent = (mock: jest.Mock): GroupEvent => {
    const calls = mock.mock.calls as Array<[GroupEvent]>;
    if (!calls[0]) throw new Error('Expected a group event');
    return calls[0][0];
  };

  it('maps action add to a join GroupEvent, normalizing the v7 participant objects to neutral ids', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1782000000123);

    try {
      fakeSock.fire('group-participants.update', {
        id: '123-456@g.us',
        author: '628444@s.whatsapp.net',
        action: 'add',
        // The v7 wire shape: parsed JSON objects ({ id, phoneNumber?, lid?, ... }), not JID strings
        // (Socket/messages-recv.js stringifies them into messageStubParameters).
        participants: [
          { id: '628111@s.whatsapp.net', admin: null },
          // A lid-addressed participant carrying its phone twin: the inline phoneNumber wins, so the
          // neutral id does not depend on whether the lid->pn mapping was learned.
          { id: '555@lid', phoneNumber: '628222@s.whatsapp.net' },
        ],
      });
    } finally {
      now.mockRestore();
    }

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(firstEvent(onGroupEvent)).toEqual({
      kind: 'join',
      groupId: '123-456@g.us',
      actorId: '628444@c.us',
      participantIds: ['628111@c.us', '628222@c.us'],
      timestamp: 1782000000, // the Baileys event is undated: stamped at receipt
    });
  });

  it('maps action remove to a leave GroupEvent', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      author: '628444@s.whatsapp.net',
      action: 'remove',
      participants: [{ id: '628111@s.whatsapp.net' }],
    });

    expect(firstEvent(onGroupEvent)).toMatchObject({
      kind: 'leave',
      groupId: '123-456@g.us',
      actorId: '628444@c.us',
      participantIds: ['628111@c.us'],
    });
  });

  it.each(['promote', 'demote', 'modify'])('skips action %s (no membership change)', async action => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      author: '628444@s.whatsapp.net',
      action,
      participants: [{ id: '628111@s.whatsapp.net' }],
    });

    expect(onGroupEvent).not.toHaveBeenCalled();
  });

  it('still normalizes plain-string participants (the pre-v7 shape)', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      author: '628444@s.whatsapp.net',
      action: 'add',
      participants: ['628111@s.whatsapp.net'],
    });

    expect(firstEvent(onGroupEvent).participantIds).toEqual(['628111@c.us']);
  });

  it('resolves a lid-only participant through the learned lid->pn mapping, else keeps the lid', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      action: 'add',
      participants: [{ id: '111@lid' }],
    });
    // No mapping known yet: the privacy id is kept, not faked into a phone number.
    expect(firstEvent(onGroupEvent).participantIds).toEqual(['111@lid']);

    fakeSock.fire('lid-mapping.update', { lid: '111@lid', pn: '628111@s.whatsapp.net' });
    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      action: 'add',
      participants: [{ id: '111@lid' }],
    });
    const calls = onGroupEvent.mock.calls as Array<[GroupEvent]>;
    expect(calls[1][0].participantIds).toEqual(['628111@c.us']);
  });

  it('prefers authorPn over a lid author for the neutral actorId', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      author: '999@lid',
      authorPn: '628777@s.whatsapp.net',
      action: 'add',
      participants: [{ id: '628111@s.whatsapp.net' }],
    });

    expect(firstEvent(onGroupEvent).actorId).toBe('628777@c.us');
  });

  it('omits actorId when the event reports no author at all', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('group-participants.update', {
      id: '123-456@g.us',
      action: 'add',
      participants: [{ id: '628111@s.whatsapp.net' }],
    });

    expect(firstEvent(onGroupEvent).actorId).toBeUndefined();
  });

  it('maps groups.update entries to update GroupEvents with the neutral changes delta', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('groups.update', [
      { id: '123-456@g.us', subject: 'New name', author: '628444@s.whatsapp.net' },
      { id: '123-456@g.us', desc: 'New description' },
      { id: '123-456@g.us', announce: true },
      { id: '123-456@g.us', restrict: false },
    ]);

    const calls = onGroupEvent.mock.calls as Array<[GroupEvent]>;
    expect(calls).toHaveLength(4);
    expect(calls[0][0]).toMatchObject({
      kind: 'update',
      groupId: '123-456@g.us',
      actorId: '628444@c.us',
      participantIds: [],
      changes: { subject: 'New name' },
    });
    expect(calls[1][0].changes).toEqual({ description: 'New description' }); // desc -> description
    expect(calls[2][0].changes).toEqual({ announce: true });
    expect(calls[3][0].changes).toEqual({ locked: false }); // restrict -> locked
  });

  it('still emits an update with empty changes for unmodeled fields (inviteCode & co.)', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('groups.update', [{ id: '123-456@g.us', inviteCode: 'ABCDEF' }]);

    // Parity with the wwebjs adapter: the occurrence is never dropped silently.
    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(firstEvent(onGroupEvent)).toMatchObject({ kind: 'update', groupId: '123-456@g.us', changes: {} });
  });

  it('skips groups.update entries without an id but still emits the rest', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    fakeSock.fire('groups.update', [{ subject: 'orphan' }, { id: '123-456@g.us', subject: 'Kept' }]);

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(firstEvent(onGroupEvent).changes).toEqual({ subject: 'Kept' });
  });

  it('skips full-metadata snapshots (groupFetchAllParticipating emits them via the same event)', async () => {
    const { onGroupEvent } = await readyWithGroupEvents();

    // The extractGroupMetadata shape emitted by groupFetchAllParticipating (Socket/groups.js:56) —
    // fired on every connect (hydrateNames) and every REST getGroups(). Treating it as a delta
    // would flood consumers with bogus group.update webhooks on each reconnect / GET /groups.
    fakeSock.fire('groups.update', [
      {
        id: '123-456@g.us',
        subject: 'Existing name',
        desc: 'Existing description',
        announce: false,
        restrict: false,
        participants: [{ id: '628111@s.whatsapp.net', admin: 'admin' }],
        creation: 1700000000,
        subjectTime: 1700000001,
        owner: '628999@s.whatsapp.net',
        size: 2,
      },
      // A real delta in the same batch still emits (process-message.js emitGroupUpdate shape).
      { id: '123-456@g.us', subject: 'Renamed' },
    ]);

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    expect(firstEvent(onGroupEvent).changes).toEqual({ subject: 'Renamed' });
  });
});

describe('BaileysAdapter call events (call offer) + rejectCall', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyWithCallEvents = async (): Promise<{ adapter: BaileysAdapter; onCall: jest.Mock }> => {
    const onCall = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onCall }));
    fakeSock.fire('connection.update', { connection: 'open' });
    return { adapter, onCall };
  };

  const offer = (over: Record<string, unknown> = {}) => ({
    chatId: '628111@s.whatsapp.net',
    from: '628111@s.whatsapp.net',
    id: 'CALL1',
    date: new Date(1782000000000),
    isVideo: false,
    isGroup: false,
    status: 'offer',
    offline: false,
    ...over,
  });

  const firstCallEvent = (mock: jest.Mock): IncomingCallEvent => {
    const calls = mock.mock.calls as Array<[IncomingCallEvent]>;
    if (!calls[0]) throw new Error('Expected a call event');
    return calls[0][0];
  };

  it('maps an offer to a neutral IncomingCallEvent (timestamp from the event date)', async () => {
    const { onCall } = await readyWithCallEvents();

    fakeSock.fire('call', [offer({ isVideo: true })]);

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(firstCallEvent(onCall)).toEqual({
      callId: 'CALL1',
      from: '628111@c.us', // @s.whatsapp.net folded to the neutral @c.us
      isVideo: true,
      isGroup: false,
      timestamp: 1782000000,
    });
  });

  it('prefers callerPn over a lid caller for the neutral from', async () => {
    const { onCall } = await readyWithCallEvents();

    fakeSock.fire('call', [offer({ from: '555@lid', callerPn: '628222@s.whatsapp.net' })]);

    expect(firstCallEvent(onCall).from).toBe('628222@c.us');
  });

  // Baileys folds both the `offer` and `offer_notice` wire tags onto status 'offer' with the same
  // call-id, so one ringing call can reach the handler more than once.
  it('emits once per call id even when the same offer arrives repeatedly', async () => {
    const { onCall } = await readyWithCallEvents();

    fakeSock.fire('call', [offer()]);
    fakeSock.fire('call', [offer()]);
    fakeSock.fire('call', [offer()]);

    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeats delivered in a single batch', async () => {
    const { onCall } = await readyWithCallEvents();

    fakeSock.fire('call', [offer(), offer()]);

    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('still emits for a genuinely different call id', async () => {
    const { onCall } = await readyWithCallEvents();

    fakeSock.fire('call', [offer({ id: 'CALL1' }), offer({ id: 'CALL2' })]);

    expect(onCall).toHaveBeenCalledTimes(2);
  });

  it('a deduplicated repeat does not evict the live call', async () => {
    const { adapter } = await readyWithCallEvents();

    fakeSock.fire('call', [offer()]);
    fakeSock.fire('call', [offer()]);

    await expect(adapter.rejectCall('CALL1')).resolves.toBeUndefined();
  });

  // Discriminating on the REFRESH specifically: the second offer lands 90s in, so the entry is only
  // expired at 150s if its expiry was never extended. LIVE_CALL_TTL_MS is 120s.
  it('a repeat extends the rejectable window from the latest offer, not the first', async () => {
    const { adapter } = await readyWithCallEvents();
    jest.useFakeTimers();
    try {
      fakeSock.fire('call', [offer()]);
      jest.advanceTimersByTime(90_000);
      fakeSock.fire('call', [offer()]);
      jest.advanceTimersByTime(60_000); // 150s after the first offer, 60s after the second

      await expect(adapter.rejectCall('CALL1')).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a call still expires when no repeat arrives', async () => {
    const { adapter } = await readyWithCallEvents();
    jest.useFakeTimers();
    try {
      fakeSock.fire('call', [offer()]);
      jest.advanceTimersByTime(150_000);

      await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['ringing', 'preaccept', 'transport', 'relaylatency', 'timeout', 'reject', 'accept', 'terminate'])(
    'skips status %s (lifecycle update, not a new incoming call)',
    async status => {
      const { onCall } = await readyWithCallEvents();

      fakeSock.fire('call', [offer({ status })]);

      expect(onCall).not.toHaveBeenCalled();
    },
  );

  it('rejectCall passes the cached raw callFrom JID to the socket and evicts the entry', async () => {
    const { adapter } = await readyWithCallEvents();
    fakeSock.fire('call', [offer({ from: '555@lid', callerPn: '628222@s.whatsapp.net' })]);

    await adapter.rejectCall('CALL1');

    // The raw `from` (the lid JID), NOT the neutralized/phone twin — Baileys expects the wire id.
    expect(fakeSock.rejectCall).toHaveBeenCalledWith('CALL1', '555@lid');
    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
  });

  it('rejectCall on an unknown id throws CallNotFoundError (HTTP 404)', async () => {
    const { adapter } = await readyWithCallEvents();

    await expect(adapter.rejectCall('NOPE')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(fakeSock.rejectCall).not.toHaveBeenCalled();
  });

  it('rejectCall on an expired entry throws CallNotFoundError without touching the socket', async () => {
    const { adapter } = await readyWithCallEvents();
    fakeSock.fire('call', [offer()]);
    // Age the cached entry past the TTL (calls ring ~a minute; the handle dies with the call).
    const cache = (adapter as unknown as { liveCalls: Map<string, { expiresAt: number }> }).liveCalls;
    cache.get('CALL1')!.expiresAt = Date.now() - 1;

    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(fakeSock.rejectCall).not.toHaveBeenCalled();
  });

  it('teardown clears the live-call cache (reject after disconnect -> not found)', async () => {
    const { adapter } = await readyWithCallEvents();
    fakeSock.fire('call', [offer()]);

    await adapter.disconnect();

    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(fakeSock.rejectCall).not.toHaveBeenCalled();
  });

  it('skips an offline-replayed offer (missed while disconnected) — no event, nothing cached', async () => {
    const { adapter, onCall } = await readyWithCallEvents();

    // Baileys replays offers for calls missed while offline with offline: true
    // (messages-recv.js:1458); the call is long dead, so rejecting it later must 404.
    fakeSock.fire('call', [offer({ offline: true })]);

    expect(onCall).not.toHaveBeenCalled();
    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(fakeSock.rejectCall).not.toHaveBeenCalled();
  });

  it("skips an offer from the account's own JID (relayed outgoing-call signaling)", async () => {
    const { onCall } = await readyWithCallEvents();

    // fakeSock.user.id is 628999:1@s.whatsapp.net -> own neutral id 628999@c.us.
    fakeSock.fire('call', [offer({ from: '628999@s.whatsapp.net', chatId: '628999@s.whatsapp.net' })]);

    expect(onCall).not.toHaveBeenCalled();
  });

  it('skips an offer whose chatId is the own JID even when from is someone else', async () => {
    const { onCall } = await readyWithCallEvents();

    fakeSock.fire('call', [offer({ from: '628111@s.whatsapp.net', chatId: '628999:1@s.whatsapp.net' })]);

    expect(onCall).not.toHaveBeenCalled();
  });

  it('still emits an offer when the own id is unknown (sock.user undefined) — null-safe guard', async () => {
    const { onCall } = await readyWithCallEvents();
    fakeSock.user = undefined;

    fakeSock.fire('call', [offer()]);

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(firstCallEvent(onCall).from).toBe('628111@c.us');
  });

  it('a terminal close (440 connectionReplaced) clears the live-call cache', async () => {
    const { adapter } = await readyWithCallEvents();
    fakeSock.fire('call', [offer()]);

    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });

    // Dead entries must surface as 404, not as a reject attempted on the dead connection.
    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(fakeSock.rejectCall).not.toHaveBeenCalled();
  });

  it('a terminal close (403 forbidden) clears the live-call cache', async () => {
    const { adapter } = await readyWithCallEvents();
    fakeSock.fire('call', [offer()]);

    fakeSock.fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 403 } } },
    });

    await expect(adapter.rejectCall('CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
    expect(fakeSock.rejectCall).not.toHaveBeenCalled();
  });
});

describe('BaileysAdapter profile + block', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('getProfilePicture returns the url, or null when none', async () => {
    fakeSock.profilePictureUrl.mockResolvedValueOnce('https://pps/x.jpg');
    const adapter = await ready();
    expect(await adapter.getProfilePicture('628111@s.whatsapp.net')).toBe('https://pps/x.jpg');
    expect(fakeSock.profilePictureUrl).toHaveBeenCalledWith('628111@s.whatsapp.net', 'image');
    fakeSock.profilePictureUrl.mockRejectedValueOnce(new Error('no picture'));
    expect(await adapter.getProfilePicture('628222@s.whatsapp.net')).toBeNull();
  });

  it('blockContact / unblockContact call updateBlockStatus', async () => {
    const adapter = await ready();
    await adapter.blockContact('628111@s.whatsapp.net');
    expect(fakeSock.updateBlockStatus).toHaveBeenCalledWith('628111@s.whatsapp.net', 'block');
    await adapter.unblockContact('628111@s.whatsapp.net');
    expect(fakeSock.updateBlockStatus).toHaveBeenCalledWith('628111@s.whatsapp.net', 'unblock');
  });
});

describe('BaileysAdapter contact + chat reads', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    // Keep hydrateNames() (runs on 'open') inert; clearAllMocks doesn't reset a prior mockResolvedValue.
    fakeSock.groupFetchAllParticipating.mockResolvedValue({});
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('populates contacts from contacts.upsert and reads them', async () => {
    const adapter = await ready();
    fakeSock.fire('contacts.upsert', [{ id: '628111@s.whatsapp.net', notify: 'Al' }]);
    const contacts = await adapter.getContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ id: '628111@c.us', pushName: 'Al', number: '628111' });
    expect((await adapter.getContactById('628111@s.whatsapp.net'))?.number).toBe('628111');
    expect((await adapter.getContactById('628111@c.us'))?.id).toBe('628111@c.us'); // neutral id round-trips
    expect(await adapter.getContactById('x@s.whatsapp.net')).toBeNull();
  });

  it('populates chats + last message and reads getChats', async () => {
    const adapter = await ready();
    fakeSock.fire('chats.upsert', [{ id: '628111@s.whatsapp.net', name: 'Alice', unreadCount: 1 }]);
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
          message: { conversation: 'hi' },
          messageTimestamp: 1700000010,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    const chats = await adapter.getChats();
    expect(chats[0]).toEqual({
      id: '628111@c.us',
      name: 'Alice',
      isGroup: false,
      kind: 'individual',
      unreadCount: 1,
      timestamp: 1700000010,
      lastMessage: 'hi',
    });
  });

  it('populates from messaging-history.set incl. lid mappings', async () => {
    const adapter = await ready();
    fakeSock.fire('messaging-history.set', {
      contacts: [{ id: '628222@s.whatsapp.net', name: 'Bob' }],
      chats: [{ id: '628222@s.whatsapp.net', name: 'Bob' }],
      messages: [],
      lidPnMappings: [{ lid: '111@lid', pn: '628999@s.whatsapp.net' }],
    });
    expect(await adapter.getContacts()).toHaveLength(1);
    expect(await adapter.resolveContactPhone('111@lid')).toBe('628999');
    expect(await adapter.resolveContactPhone('628222@s.whatsapp.net')).toBe('628222');
  });

  it('contact/chat reads reject with EngineNotReadyError before connect', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.getContacts()).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

describe('BaileysAdapter sendSeen + markUnread + deleteChat', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyWithMessage = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
          message: { conversation: 'hi' },
          messageTimestamp: 1700000020,
        },
      ],
    });
    await new Promise(r => setImmediate(r)); // let async processInboundMessage complete
    return adapter;
  };

  it('sendSeen marks the last message read and returns true', async () => {
    const adapter = await readyWithMessage();
    const ok = await adapter.sendSeen('628111@s.whatsapp.net');
    expect(ok).toBe(true);
    expect(fakeSock.readMessages).toHaveBeenCalledWith([
      { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
    ]);
  });

  it('sendSeen returns false when no last message is known', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(await adapter.sendSeen('628999@s.whatsapp.net')).toBe(false);
    expect(fakeSock.readMessages).not.toHaveBeenCalled();
  });

  it('markUnread marks the chat unread via chatModify with the last message', async () => {
    const adapter = await readyWithMessage();
    const ok = await adapter.markUnread('628111@s.whatsapp.net');
    expect(ok).toBe(true);
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      {
        markRead: false,
        lastMessages: [
          { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' }, messageTimestamp: 1700000020 },
        ],
      },
      '628111@s.whatsapp.net',
    );
  });

  it('markUnread returns false when no last message is known', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(await adapter.markUnread('628999@s.whatsapp.net')).toBe(false);
    expect(fakeSock.chatModify).not.toHaveBeenCalled();
  });

  it('deleteChat revokes the chat via chatModify with the last message', async () => {
    const adapter = await readyWithMessage();
    const ok = await adapter.deleteChat('628111@s.whatsapp.net');
    expect(ok).toBe(true);
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      {
        delete: true,
        lastMessages: [
          { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' }, messageTimestamp: 1700000020 },
        ],
      },
      '628111@s.whatsapp.net',
    );
  });

  it('deleteChat returns false when no last message is known', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(await adapter.deleteChat('628999@s.whatsapp.net')).toBe(false);
    expect(fakeSock.chatModify).not.toHaveBeenCalled();
  });

  it('clearChatMessages clears via chatModify with the last message', async () => {
    const adapter = await readyWithMessage();
    expect(await adapter.clearChatMessages('628111@s.whatsapp.net')).toBe(true);
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      {
        clear: true,
        lastMessages: [
          { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' }, messageTimestamp: 1700000020 },
        ],
      },
      '628111@s.whatsapp.net',
    );
  });

  it('clearChatMessages returns false for a chat with no known history', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(await adapter.clearChatMessages('628999@s.whatsapp.net')).toBe(false);
    expect(fakeSock.chatModify).not.toHaveBeenCalled();
  });

  it('setGroupPicture targets the GROUP jid, not the own account', async () => {
    const adapter = await readyWithMessage();
    await adapter.setGroupPicture('120363@g.us', { mimetype: 'image/png', data: 'QUJD' });
    expect(fakeSock.updateProfilePicture).toHaveBeenCalledWith('120363@g.us', expect.any(Buffer));
  });

  it('deleteGroupPicture removes by the GROUP jid', async () => {
    const adapter = await readyWithMessage();
    await adapter.deleteGroupPicture('120363@g.us');
    expect(fakeSock.removeProfilePicture).toHaveBeenCalledWith('120363@g.us');
  });

  it('upsertContact addresses the entry by JID and composes fullName', async () => {
    const adapter = await readyWithMessage();
    await adapter.upsertContact('628111@s.whatsapp.net', 'Ada', 'Lovelace');
    // Baileys wants the JID here, unlike whatsapp-web.js which wants a bare phone number.
    expect(fakeSock.addOrEditContact).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      firstName: 'Ada',
      fullName: 'Ada Lovelace',
      saveOnPrimaryAddressbook: false,
    });
  });

  it('upsertContact leaves no trailing space in fullName for a single-name contact', async () => {
    const adapter = await readyWithMessage();
    await adapter.upsertContact('628111@s.whatsapp.net', 'Ada');
    expect(fakeSock.addOrEditContact).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      expect.objectContaining({ fullName: 'Ada' }),
    );
  });

  it('deleteContact removes by JID', async () => {
    const adapter = await readyWithMessage();
    await adapter.deleteContact('628111@s.whatsapp.net');
    expect(fakeSock.removeContact).toHaveBeenCalledWith('628111@s.whatsapp.net');
  });

  it.each([true, false])('archiveChat(%s) modifies the chat with the last message', async archive => {
    const adapter = await readyWithMessage();
    const ok = await adapter.archiveChat('628111@s.whatsapp.net', archive);
    expect(ok).toBe(true);
    expect(fakeSock.chatModify).toHaveBeenCalledWith(
      {
        archive,
        lastMessages: [
          { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' }, messageTimestamp: 1700000020 },
        ],
      },
      '628111@s.whatsapp.net',
    );
  });

  it('archiveChat returns false for a chat with no known history, rather than throwing', async () => {
    // The app-state modification is keyed to the chat's last message; there is nothing to
    // synthesize one from, so this is a defined outcome the endpoint reports as success:false.
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(await adapter.archiveChat('628999@s.whatsapp.net', true)).toBe(false);
    expect(fakeSock.chatModify).not.toHaveBeenCalled();
  });

  /**
   * The neutral @c.us id the gateway API and getContacts speak must be folded to the engine
   * @s.whatsapp.net form before it becomes the app-state index key. chatModify/addOrEditContact
   * (unlike the send path) do NOT call jidNormalizedUser, so a raw @c.us would key the mutation
   * under an index WhatsApp never reads — the write silently targets nothing while the endpoint
   * reports success. These pass the neutral id (the shape a list-then-mutate round-trip yields).
   */
  describe('folds the neutral @c.us id to the engine form for chatModify/contact app-state ops', () => {
    it('upsertContact folds @c.us -> @s.whatsapp.net', async () => {
      const adapter = await readyWithMessage();
      await adapter.upsertContact('628111@c.us', 'Ada');
      expect(fakeSock.addOrEditContact).toHaveBeenCalledWith('628111@s.whatsapp.net', expect.any(Object));
    });

    it('deleteContact folds @c.us -> @s.whatsapp.net', async () => {
      const adapter = await readyWithMessage();
      await adapter.deleteContact('628111@c.us');
      expect(fakeSock.removeContact).toHaveBeenCalledWith('628111@s.whatsapp.net');
    });

    it('clearChatMessages folds the chatModify index jid for a 1:1 chat', async () => {
      const adapter = await readyWithMessage();
      expect(await adapter.clearChatMessages('628111@c.us')).toBe(true);
      expect(fakeSock.chatModify).toHaveBeenCalledWith(
        expect.objectContaining({ clear: true }),
        '628111@s.whatsapp.net',
      );
    });

    it('archiveChat folds the chatModify index jid for a 1:1 chat', async () => {
      const adapter = await readyWithMessage();
      expect(await adapter.archiveChat('628111@c.us', true)).toBe(true);
      expect(fakeSock.chatModify).toHaveBeenCalledWith(
        expect.objectContaining({ archive: true }),
        '628111@s.whatsapp.net',
      );
    });

    it('starMessage folds the chatModify index jid for a 1:1 chat', async () => {
      fakeStore.getMessage.mockResolvedValue({
        key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'M1' },
        message: { conversation: 'hi' },
        messageTimestamp: 1700000020,
      });
      const adapter = await readyWithMessage();
      await adapter.starMessage('628111@c.us', 'TARGET', true);
      expect(fakeSock.chatModify).toHaveBeenCalledWith(
        { star: { messages: [{ id: 'M1', fromMe: false }], star: true } },
        '628111@s.whatsapp.net',
      );
    });

    it('leaves a group @g.us id unchanged (identical in both dialects)', async () => {
      const adapter = await readyWithMessage();
      // A group last-message lives under the g.us key; seed one so archive proceeds.
      fakeSock.fire('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '120363@g.us', fromMe: false, id: 'G1' },
            message: { conversation: 'hi' },
            messageTimestamp: 1700000021,
          },
        ],
      });
      await new Promise(resolve => setImmediate(resolve));
      await adapter.archiveChat('120363@g.us', true);
      expect(fakeSock.chatModify).toHaveBeenCalledWith(expect.objectContaining({ archive: true }), '120363@g.us');
    });
  });
});

describe('BaileysAdapter status posting', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks());
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('postTextStatus sends to status@broadcast with denormalized statusJidList + styling, no store write', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'STATUS1' }, messageTimestamp: 1719600000 });
    const adapter = await ready();
    const result = await adapter.postTextStatus('hello', {
      recipients: ['628111@c.us', '628222@lid'],
      backgroundColor: '#25D366',
      font: 2,
    });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      { text: 'hello' },
      {
        statusJidList: ['628111@s.whatsapp.net', '628222@lid'],
        backgroundColor: '#25D366',
        font: 2,
      },
    );
    expect(result.statusId).toBe('STATUS1');
    expect(result.expiresAt.getTime() - result.timestamp.getTime()).toBe(24 * 3_600_000);
    expect(fakeStore.put).not.toHaveBeenCalled();
  });

  it('postImageStatus resolves media and threads recipients', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'IMG1' }, messageTimestamp: 1719600000 });
    const adapter = await ready();
    await adapter.postImageStatus(
      { mimetype: 'image/png', data: Buffer.from([1, 2, 3]) },
      { recipients: ['628111@c.us'], caption: 'cap' },
    );
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      { image: Buffer.from([1, 2, 3]), caption: 'cap', mimetype: 'image/png' },
      { statusJidList: ['628111@s.whatsapp.net'], backgroundColor: undefined, font: undefined },
    );
    expect(fakeStore.put).not.toHaveBeenCalled();
  });

  it('postVideoStatus resolves media and threads recipients', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'VID1' }, messageTimestamp: 1719600000 });
    const adapter = await ready();
    await adapter.postVideoStatus({ mimetype: 'video/mp4', data: 'AAAA' }, { recipients: ['628111@c.us'] });
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      { video: Buffer.from('AAAA', 'base64'), caption: undefined, mimetype: 'video/mp4' },
      { statusJidList: ['628111@s.whatsapp.net'], backgroundColor: undefined, font: undefined },
    );
  });

  it('postStatus rejects an absent/empty recipients list with a 400 (Baileys posts to exactly the allow-list)', async () => {
    const adapter = await ready();
    await expect(adapter.postTextStatus('hello', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(adapter.postTextStatus('hello', { recipients: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });

  it('deleteStatus revokes by constructing the key from statusId (no store lookup)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'STATUS1' } });
    const adapter = await ready();
    await adapter.deleteStatus('STATUS1');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('status@broadcast', {
      delete: {
        remoteJid: 'status@broadcast',
        fromMe: true,
        id: 'STATUS1',
        participant: '628999@s.whatsapp.net',
      },
    });
    expect(fakeStore.getMessage).not.toHaveBeenCalled();
  });
});

describe('BaileysAdapter proxy support', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const proxied = (proxyUrl: string): BaileysAdapter =>
    new BaileysAdapter({
      sessionId: 'sess-1',
      dbSessionId: 'db-uuid-1',
      authDir: './data/baileys',
      messageStore: fakeStore,
      proxyUrl,
    });

  const makeWASocketMock = (): jest.Mock =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    jest.requireMock('@whiskeysockets/baileys').default as jest.Mock;

  const lastSocketConfig = (): Record<string, unknown> => {
    const calls = makeWASocketMock().mock.calls as Array<[Record<string, unknown>]>;
    const last = calls.at(-1);
    if (!last) throw new Error('Expected makeWASocket to have been called');
    return last[0];
  };

  it('selects HttpsProxyAgent for http/https proxy URLs', () => {
    expect(createProxyAgent('http://user:pass@proxy.example:8080')).toBeInstanceOf(HttpsProxyAgent);
    expect(createProxyAgent('https://proxy.example:443')).toBeInstanceOf(HttpsProxyAgent);
  });

  it('selects SocksProxyAgent for socks4/socks5 proxy URLs', () => {
    expect(createProxyAgent('socks5://user:pass@proxy.example:1080')).toBeInstanceOf(SocksProxyAgent);
    expect(createProxyAgent('socks4://proxy.example:1080')).toBeInstanceOf(SocksProxyAgent);
  });

  it('throws on an unsupported proxy scheme', () => {
    expect(() => createProxyAgent('ftp://proxy.example:21')).toThrow(/unsupported proxy/i);
  });

  it('passes the agent to makeWASocket as both agent (WS) and fetchAgent (media)', async () => {
    await proxied('http://user:pass@proxy.example:8080').initialize(noopCallbacks());
    const cfg = lastSocketConfig();
    expect(cfg.agent).toBeInstanceOf(HttpsProxyAgent);
    expect(cfg.fetchAgent).toBe(cfg.agent);
  });

  it('passes a SOCKS agent through for a socks5 URL', async () => {
    await proxied('socks5://user:pass@proxy.example:1080').initialize(noopCallbacks());
    expect(lastSocketConfig().agent).toBeInstanceOf(SocksProxyAgent);
  });

  it('leaves agent/fetchAgent unset without a proxyUrl', async () => {
    await newAdapter().initialize(noopCallbacks());
    const cfg = lastSocketConfig();
    expect(cfg.agent).toBeUndefined();
    expect(cfg.fetchAgent).toBeUndefined();
  });

  it('fails closed: an unusable proxy value fails initialize instead of connecting direct', async () => {
    const onError = jest.fn();
    const adapter = proxied('ftp://proxy.example:21');
    await expect(adapter.initialize(noopCallbacks({ onError }))).rejects.toThrow(/unsupported proxy/i);
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalled();
    expect(makeWASocketMock()).not.toHaveBeenCalled();
  });
});

describe('BaileysAdapter catalog (#905)', () => {
  const selfUser = { id: '628999:12@s.whatsapp.net', name: 'Me' };

  const baileysProduct = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    name: 'Coffee',
    description: 'Beans',
    price: 1500,
    currency: 'USD',
    imageUrls: { requested: 'https://img.example/x.jpg' },
    reviewStatus: { whatsapp: 'approved' },
    availability: 'in stock',
    retailerId: 'SKU1',
    url: 'https://shop.example/p1',
    isHidden: false,
    ...over,
  });

  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.signalRepository = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.user = selfUser;
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('getCatalog maps the first collection to catalog metadata', async () => {
    const adapter = await ready();
    fakeSock.getCollections.mockResolvedValue({
      collections: [
        {
          id: 'coll-1',
          name: 'Best Sellers',
          products: [baileysProduct(), baileysProduct({ id: 'p2' })],
          status: { status: 'ok', canAppeal: false },
        },
      ],
    });

    await expect(adapter.getCatalog()).resolves.toEqual({
      id: 'coll-1',
      name: 'Best Sellers',
      productCount: 2,
      url: 'https://wa.me/c/628999',
    });
    expect(fakeSock.getCollections).toHaveBeenCalledWith('628999@s.whatsapp.net');
  });

  it('getCatalog returns null when the business has no collections', async () => {
    const adapter = await ready();
    fakeSock.getCollections.mockResolvedValue({ collections: [] });

    await expect(adapter.getCatalog()).resolves.toBeNull();
  });

  it('getProducts walks the catalog cursor and slices the requested page', async () => {
    const adapter = await ready();
    fakeSock.getCatalog
      .mockResolvedValueOnce({ products: [baileysProduct(), baileysProduct({ id: 'p2' })], nextPageCursor: 'C2' })
      .mockResolvedValueOnce({ products: [baileysProduct({ id: 'p3' })], nextPageCursor: undefined });

    const res = await adapter.getProducts({ page: 2, limit: 2 });

    expect(res.products.map(p => p.id)).toEqual(['p3']);
    expect(res.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(fakeSock.getCatalog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ jid: '628999@s.whatsapp.net', cursor: undefined }),
    );
    expect(fakeSock.getCatalog).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'C2' }));
  });

  it('getProducts maps the Baileys product shape onto Product', async () => {
    const adapter = await ready();
    fakeSock.getCatalog.mockResolvedValue({ products: [baileysProduct()], nextPageCursor: undefined });

    const { products } = await adapter.getProducts({ page: 1, limit: 10 });

    expect(products[0]).toEqual({
      id: 'p1',
      name: 'Coffee',
      description: 'Beans',
      price: 1500,
      currency: 'USD',
      priceFormatted: '$1,500.00',
      imageUrl: 'https://img.example/x.jpg',
      url: 'https://shop.example/p1',
      isAvailable: true,
      retailerId: 'SKU1',
    });
  });

  it('getProduct returns the product with the matching id', async () => {
    const adapter = await ready();
    fakeSock.getCatalog.mockResolvedValue({
      products: [baileysProduct(), baileysProduct({ id: 'p2', name: 'Tea' })],
      nextPageCursor: undefined,
    });

    const res = await adapter.getProduct('p2');

    expect(res?.id).toBe('p2');
    expect(res?.name).toBe('Tea');
  });

  it('getProduct returns null for an unknown id', async () => {
    const adapter = await ready();
    fakeSock.getCatalog.mockResolvedValue({ products: [baileysProduct()], nextPageCursor: undefined });

    await expect(adapter.getProduct('nope')).resolves.toBeNull();
  });

  it('sendProduct sends a product message built from the catalog entry', async () => {
    const adapter = await ready();
    fakeSock.getCatalog.mockResolvedValue({ products: [baileysProduct()], nextPageCursor: undefined });
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1700000005 });

    const res = await adapter.sendProduct('628111@s.whatsapp.net', 'p1', 'check this');

    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      product: {
        productId: 'p1',
        title: 'Coffee',
        description: 'Beans',
        currencyCode: 'USD',
        priceAmount1000: 1500000,
        retailerId: 'SKU1',
        url: 'https://shop.example/p1',
        productImage: { url: 'https://img.example/x.jpg' },
      },
      businessOwnerJid: '628999@s.whatsapp.net',
      body: 'check this',
    });
    expect(res).toEqual({ id: 'M1', timestamp: 1700000005 });
  });

  it('sendProduct rejects NotFound when the product id is unknown', async () => {
    const adapter = await ready();
    fakeSock.getCatalog.mockResolvedValue({ products: [baileysProduct()], nextPageCursor: undefined });

    await expect(adapter.sendProduct('628111@s.whatsapp.net', 'nope')).rejects.toThrow(NotFoundException);
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });

  it('sendProduct rejects BadRequest when the product has no image', async () => {
    const adapter = await ready();
    fakeSock.getCatalog.mockResolvedValue({ products: [baileysProduct({ imageUrls: {} })], nextPageCursor: undefined });

    await expect(adapter.sendProduct('628111@s.whatsapp.net', 'p1')).rejects.toThrow(BadRequestException);
    expect(fakeSock.sendMessage).not.toHaveBeenCalled();
  });
});

// Baileys models the reachout timelock first-class — a typed state with both a push notification and
// a query — so this is not inference from failed sends. The account stays connected throughout: a
// timelock blocks only the start of NEW conversations, which is why nothing here touches status.
describe('BaileysAdapter account-restriction reporting', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    fakeSock.fetchAccountReachoutTimelock.mockResolvedValue({ isActive: false });
  });

  it('reports an active timelock with its enforcement type and expiry', async () => {
    const onAccountRestriction = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onAccountRestriction }));
    const ends = new Date('2026-08-04T09:00:00.000Z');

    fakeSock.fire('connection.update', {
      reachoutTimeLock: { isActive: true, timeEnforcementEnds: ends, enforcementType: 'BIZ_QUALITY' },
    });

    expect(onAccountRestriction).toHaveBeenCalledWith({
      kind: 'reachout_timelock',
      code: 'BIZ_QUALITY',
      expiresAt: ends.getTime(),
    });
  });

  // WhatsApp can omit the enforcement type; DEFAULT is Baileys' own name for "no specific type",
  // so the field is never left undefined for consumers to special-case.
  it('falls back to DEFAULT when no enforcement type is given', async () => {
    const onAccountRestriction = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onAccountRestriction }));

    fakeSock.fire('connection.update', { reachoutTimeLock: { isActive: true } });

    expect(onAccountRestriction).toHaveBeenCalledWith({
      kind: 'reachout_timelock',
      code: 'DEFAULT',
      expiresAt: undefined,
    });
  });

  // `time_enforcement_ends` is a server string Baileys parses with parseInt, so a malformed value
  // reaches us as an Invalid Date. NaN must not be forwarded as if it were a real expiry.
  it('drops an unparseable expiry rather than forwarding NaN', async () => {
    const onAccountRestriction = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onAccountRestriction }));

    fakeSock.fire('connection.update', {
      reachoutTimeLock: { isActive: true, timeEnforcementEnds: new Date('nonsense'), enforcementType: 'BIZ_QUALITY' },
    });

    expect(onAccountRestriction).toHaveBeenCalledWith({
      kind: 'reachout_timelock',
      code: 'BIZ_QUALITY',
      expiresAt: undefined,
    });
  });

  // Baileys reports the lift as well as the onset, so this is a positive "no restriction" and is
  // forwarded as null — consumers may clear on it.
  it('forwards a lifted timelock as null', async () => {
    const onAccountRestriction = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onAccountRestriction }));

    fakeSock.fire('connection.update', { reachoutTimeLock: { isActive: false } });

    expect(onAccountRestriction).toHaveBeenCalledWith(null);
  });

  // The push only fires when the state CHANGES, so a gateway that starts while the account is
  // already restricted would never be told. Asking on every connection is what closes that gap.
  it('asks WhatsApp for the current restriction on every connection open', async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));

    fakeSock.fire('connection.update', { connection: 'open' });
    await new Promise(r => setImmediate(r));

    expect(fakeSock.fetchAccountReachoutTimelock).toHaveBeenCalledTimes(1);
  });

  // An account or server that will not answer the query must not turn a healthy connection into a
  // failure — the connection is already open and READY by this point.
  it('survives a probe that rejects, leaving the session READY', async () => {
    fakeSock.fetchAccountReachoutTimelock.mockRejectedValue(new Error('not-authorized'));
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };

    fakeSock.fire('connection.update', { connection: 'open' });
    await new Promise(r => setImmediate(r));

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
  });

  // Detection is observation only: a timelock leaves the account connected, so treating it as a
  // disconnect would tear down a session that is still able to serve every existing chat.
  it('does not disturb the session status or connection when a timelock arrives', async () => {
    const onDisconnected = jest.fn();
    const onError = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onDisconnected, onError }));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });

    fakeSock.fire('connection.update', { reachoutTimeLock: { isActive: true, enforcementType: 'BIZ_QUALITY' } });

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

// Presence is push-only after a subscription — it cannot be queried — so the mapping is the only
// place a wrong shape can be caught before it reaches a public webhook payload.
describe('BaileysAdapter presence', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  /** Subscribing is a live-socket operation, so the session has to be connected first. */
  const readyAdapter = async (callbacks = noopCallbacks({})) => {
    const adapter = newAdapter();
    await adapter.initialize(callbacks);
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('subscribes through the socket for the addressed chat', async () => {
    const adapter = await readyAdapter();

    await adapter.subscribeToPresence('628111@c.us');

    expect(fakeSock.presenceSubscribe).toHaveBeenCalledTimes(1);
  });

  // Unlike the typing indicator next door, this one is NOT best-effort: the caller asked for a
  // subscription, and swallowing the failure would leave them waiting for updates that never come.
  it('surfaces a failed subscription instead of swallowing it', async () => {
    const adapter = await readyAdapter();
    fakeSock.presenceSubscribe.mockRejectedValueOnce(new Error('no LID for user'));

    await expect(adapter.subscribeToPresence('628111@c.us')).rejects.toThrow('no LID for user');
  });

  it('maps a per-participant presence map onto the neutral event', async () => {
    const onPresenceUpdate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onPresenceUpdate }));

    fakeSock.fire('presence.update', {
      id: '628111@s.whatsapp.net',
      presences: { '628222@s.whatsapp.net': { lastKnownPresence: 'composing', lastSeen: 1786000000 } },
    });

    expect(onPresenceUpdate).toHaveBeenCalledWith({
      chatId: '628111@c.us',
      participants: [{ id: '628222@c.us', state: 'composing', lastSeen: 1786000000 }],
    });
  });

  // Most contacts hide last-seen, so its absence is the common case and must not become a guess.
  it('omits lastSeen rather than inventing one', async () => {
    const onPresenceUpdate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onPresenceUpdate }));

    fakeSock.fire('presence.update', {
      id: '628111@s.whatsapp.net',
      presences: { '628111@s.whatsapp.net': { lastKnownPresence: 'available' } },
    });

    const [event] = onPresenceUpdate.mock.calls[0] as [{ participants: Record<string, unknown>[] }];
    expect(event.participants[0]).not.toHaveProperty('lastSeen');
  });

  it('carries the group online count when the engine reports one', async () => {
    const onPresenceUpdate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onPresenceUpdate }));

    fakeSock.fire('presence.update', {
      id: '12036@g.us',
      presences: { '628222@s.whatsapp.net': { lastKnownPresence: 'available', groupOnlineCount: 4 } },
    });

    expect(onPresenceUpdate).toHaveBeenCalledWith(expect.objectContaining({ groupOnlineCount: 4 }));
  });

  // An unknown state crossing the library boundary lands straight in a public payload, so it is
  // dropped rather than published as if this gateway understood it.
  it('drops a participant whose state is unknown or missing', async () => {
    const onPresenceUpdate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onPresenceUpdate }));

    fakeSock.fire('presence.update', {
      id: '12036@g.us',
      presences: {
        '628222@s.whatsapp.net': { lastKnownPresence: 'telepathic' },
        '628333@s.whatsapp.net': {},
        '628444@s.whatsapp.net': { lastKnownPresence: 'available' },
      },
    });

    expect(onPresenceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ participants: [{ id: '628444@c.us', state: 'available' }] }),
    );
  });

  it('emits nothing when no participant survives the mapping', async () => {
    const onPresenceUpdate = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onPresenceUpdate }));

    fakeSock.fire('presence.update', { id: '12036@g.us', presences: { 'x@s.whatsapp.net': {} } });
    fakeSock.fire('presence.update', { id: '12036@g.us' });

    expect(onPresenceUpdate).not.toHaveBeenCalled();
  });
});

// Create, update and delete are ONE upstream write (a `label_edit` app-state patch keyed on the
// label id), so what distinguishes them is the body — and getting that body wrong silently edits the
// wrong thing rather than failing.
describe('BaileysAdapter label editing', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyAdapter = async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('writes name and colour under the caller-chosen id', async () => {
    const adapter = await readyAdapter();

    await adapter.upsertLabel({ id: 'l1', name: 'VIP', color: 3 });

    expect(fakeSock.addLabel).toHaveBeenCalledWith('628999:12@s.whatsapp.net', {
      id: 'l1',
      name: 'VIP',
      color: 3,
    });
  });

  // Colour 0 is a real WhatsApp colour, not "unset" — a falsy check here would make it unsettable.
  it('treats colour 0 as a colour', async () => {
    const adapter = await readyAdapter();

    await adapter.upsertLabel({ id: 'l1', color: 0 });

    const [, body] = fakeSock.addLabel.mock.calls[0] as [string, { color?: number }];
    expect(body.color).toBe(0);
  });

  it('deletes through the same write, with the tombstone flag', async () => {
    const adapter = await readyAdapter();

    await adapter.deleteLabel('l1');

    expect(fakeSock.addLabel).toHaveBeenCalledWith('628999:12@s.whatsapp.net', { id: 'l1', deleted: true });
  });

  // Baileys has label writes but no label query of any kind, so listing a label's chats is refused
  // rather than faked from a partial cache.
  it('refuses to list chats by label, with the method named', async () => {
    const adapter = await readyAdapter();

    await expect(adapter.getChatsByLabel('l1')).rejects.toThrow(/getChatsByLabel/);
  });
});

// Baileys has first-class newsletter admin, so these pin the mapping and the mute/unmute split
// rather than any failure translation.
describe('BaileysAdapter channel administration', () => {
  const CHANNEL = '120363401234567890@newsletter';

  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyAdapter = async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('creates a channel and maps the metadata to the neutral shape', async () => {
    fakeSock.newsletterCreate.mockResolvedValue({
      id: CHANNEL,
      name: 'Product updates',
      description: 'Release notes',
      invite: 'ABC123',
    });
    const adapter = await readyAdapter();

    const channel = await adapter.createChannel('Product updates', 'Release notes');

    expect(fakeSock.newsletterCreate).toHaveBeenCalledWith('Product updates', 'Release notes');
    expect(channel).toMatchObject({ id: CHANNEL, name: 'Product updates', inviteCode: 'ABC123' });
  });

  it('deletes a channel by id', async () => {
    const adapter = await readyAdapter();

    await expect(adapter.deleteChannel(CHANNEL)).resolves.toBeUndefined();

    expect(fakeSock.newsletterDelete).toHaveBeenCalledWith(CHANNEL);
  });

  // Two separate library calls, so the boolean must actually pick between them — a wrong branch
  // silently does the opposite of what was asked.
  it('routes mute and unmute to their own library calls', async () => {
    const adapter = await readyAdapter();

    await adapter.muteChannel(CHANNEL, true);
    expect(fakeSock.newsletterMute).toHaveBeenCalledWith(CHANNEL);
    expect(fakeSock.newsletterUnmute).not.toHaveBeenCalled();

    await adapter.muteChannel(CHANNEL, false);
    expect(fakeSock.newsletterUnmute).toHaveBeenCalledWith(CHANNEL);
  });

  // The raw Boom from executeWMexQuery used to escape as a 500 on every refused channel write.
  it.each([
    ['createChannel', (a: BaileysAdapter) => a.createChannel('X'), 'newsletterCreate'],
    ['deleteChannel', (a: BaileysAdapter) => a.deleteChannel(CHANNEL), 'newsletterDelete'],
    ['muteChannel', (a: BaileysAdapter) => a.muteChannel(CHANNEL, true), 'newsletterMute'],
  ])('%s maps a server refusal to EngineRefusedError (403)', async (_name, call, sockMethod) => {
    (fakeSock as unknown as Record<string, jest.Mock>)[sockMethod].mockRejectedValueOnce(
      Object.assign(new Error('not-authorized'), { data: 401 }),
    );
    const adapter = await readyAdapter();
    await expect(call(adapter)).rejects.toBeInstanceOf(EngineRefusedError);
  });
});

// The load-bearing risk here is an ended call re-entering the incoming-call path: a decline would
// then be published as a fresh ring and, with auto-reject on, answered as one.
describe('BaileysAdapter call outcomes', () => {
  const CALL_ID = 'CALL-1';
  const CALLER = '628111@s.whatsapp.net';

  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  /** Drive a ring first: an outcome for a call this session never saw is deliberately dropped. */
  const ringing = async (callbacks: Record<string, jest.Mock>) => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks(callbacks));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    fakeSock.fire('call', [
      {
        id: CALL_ID,
        from: CALLER,
        chatId: CALLER,
        status: 'offer',
        offline: false,
        date: new Date(1700000000000),
        isVideo: true,
      },
    ]);
    callbacks.onCall?.mockClear();
    return adapter;
  };

  it.each([
    ['accept', 'accepted'],
    ['reject', 'rejected'],
    ['timeout', 'missed'],
  ])('publishes %s as the %s outcome, and never as a new ring', async (status, outcome) => {
    const onCall = jest.fn();
    const onCallOutcome = jest.fn();
    await ringing({ onCall, onCallOutcome });

    fakeSock.fire('call', [
      {
        id: CALL_ID,
        from: CALLER,
        chatId: CALLER,
        status,
        offline: false,
        date: new Date(1700000060000),
        isVideo: true,
      },
    ]);

    expect(onCallOutcome).toHaveBeenCalledWith({
      callId: CALL_ID,
      from: '628111@c.us',
      outcome,
      isVideo: true,
      isGroup: false,
      timestamp: 1700000060,
    });
    // The whole point: an ended call must not look like an incoming one.
    expect(onCall).not.toHaveBeenCalled();
  });

  // ringing/preaccept/transport/relaylatency are transport chatter, and `terminate` cannot be told
  // apart from a hang-up after answering — publishing either would be noise or a wrong claim.
  it.each(['ringing', 'preaccept', 'transport', 'relaylatency', 'terminate'])(
    'publishes nothing for %s',
    async status => {
      const onCall = jest.fn();
      const onCallOutcome = jest.fn();
      await ringing({ onCall, onCallOutcome });

      fakeSock.fire('call', [{ id: CALL_ID, from: CALLER, chatId: CALLER, status, offline: false, date: new Date() }]);

      expect(onCallOutcome).not.toHaveBeenCalled();
      expect(onCall).not.toHaveBeenCalled();
    },
  );

  // `terminate` publishes no outcome, but it DOES end the call: the live handle must go with it,
  // or a later outcome/reject acts on a call that is already over until the TTL happens to expire.
  it('terminate drops the live call, so a later outcome for the same id is ignored', async () => {
    const onCallOutcome = jest.fn();
    await ringing({ onCall: jest.fn(), onCallOutcome });

    fakeSock.fire('call', [
      { id: CALL_ID, from: CALLER, chatId: CALLER, status: 'terminate', offline: false, date: new Date() },
    ]);
    fakeSock.fire('call', [
      { id: CALL_ID, from: CALLER, chatId: CALLER, status: 'reject', offline: false, date: new Date() },
    ]);

    expect(onCallOutcome).not.toHaveBeenCalled();
  });

  // A rejection issued through the API produces no inbound signal to observe, so it was the one
  // outcome never published — the very one the caller knows happened.
  it('publishes call.rejected when the call is rejected through the API', async () => {
    const onCallOutcome = jest.fn();
    const adapter = await ringing({ onCall: jest.fn(), onCallOutcome });

    await adapter.rejectCall(CALL_ID);

    expect(fakeSock.rejectCall).toHaveBeenCalledWith(CALL_ID, CALLER);
    expect(onCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ callId: CALL_ID, outcome: 'rejected', from: '628111@c.us' }),
    );
  });

  it('publishes nothing when the socket refuses the rejection', async () => {
    const onCallOutcome = jest.fn();
    const adapter = await ringing({ onCall: jest.fn(), onCallOutcome });
    fakeSock.rejectCall.mockRejectedValueOnce(new Error('socket closed'));

    await expect(adapter.rejectCall(CALL_ID)).rejects.toThrow('socket closed');
    expect(onCallOutcome).not.toHaveBeenCalled();
  });

  // WhatsApp replays signalling for calls that ended while the session was disconnected. Announcing
  // those would report last week's declined call as if it had just happened.
  it('drops an offline-replayed outcome', async () => {
    const onCallOutcome = jest.fn();
    await ringing({ onCall: jest.fn(), onCallOutcome });

    fakeSock.fire('call', [
      { id: CALL_ID, from: CALLER, chatId: CALLER, status: 'reject', offline: true, date: new Date() },
    ]);

    expect(onCallOutcome).not.toHaveBeenCalled();
  });

  // An outcome for a call this session never saw ring belongs to another device's conversation or
  // predates the connection, and carries no caller identity worth publishing.
  it('drops an outcome for a call that never rang here', async () => {
    const onCallOutcome = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({ onCall: jest.fn(), onCallOutcome }));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });

    fakeSock.fire('call', [
      { id: 'UNKNOWN', from: CALLER, chatId: CALLER, status: 'reject', offline: false, date: new Date() },
    ]);

    expect(onCallOutcome).not.toHaveBeenCalled();
  });

  // The call is over, so the handle rejectCall would act on must go with it — otherwise a late
  // reject would be attempted against a dead call instead of reporting not-found.
  it('drops the live-call handle, so a later reject reports not-found', async () => {
    const adapter = await ringing({ onCall: jest.fn(), onCallOutcome: jest.fn() });

    fakeSock.fire('call', [
      { id: CALL_ID, from: CALLER, chatId: CALLER, status: 'accept', offline: false, date: new Date() },
    ]);

    await expect(adapter.rejectCall(CALL_ID)).rejects.toThrow(/CALL-1/);
  });
});

// `linkPreview: null` is Baileys' explicit "no preview". With the key absent it instead calls the
// configured generator, which in this project dynamically imports a package that is not installed —
// so suppressing also spares a failing import and a warn log on every URL-bearing send.
describe('BaileysAdapter link preview', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyAdapter = async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 });
    return adapter;
  };

  const sentContent = (): Record<string, unknown> =>
    (fakeSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>])[1];

  it('sends the explicit null that suppresses the preview', async () => {
    const adapter = await readyAdapter();

    await adapter.sendTextMessage('628111@c.us', 'see https://example.com', undefined, { linkPreview: false });

    expect(sentContent().linkPreview).toBeNull();
  });

  // The key must be ABSENT, not undefined-valued: Baileys branches on `typeof urlInfo === 'undefined'`
  // to decide whether to generate, so either is equivalent — but leaving it out keeps the content
  // object identical to what a plain send has always produced.
  it('leaves the key out entirely when the preview is allowed', async () => {
    const adapter = await readyAdapter();

    await adapter.sendTextMessage('628111@c.us', 'see https://example.com', undefined, { linkPreview: true });

    expect(sentContent()).not.toHaveProperty('linkPreview');
  });

  // Previews are OPT-IN on this engine: generation means a blocking outbound fetch per URL before
  // the message can go out (a bulk campaign carrying a slow URL would stall on every message), and
  // the documented engine default is that Baileys builds none.
  it('suppresses generation for a plain send, and for a send that says nothing about previews', async () => {
    const adapter = await readyAdapter();

    await adapter.sendTextMessage('628111@c.us', 'hi');
    expect(sentContent().linkPreview).toBeNull();

    await adapter.sendTextMessage('628111@c.us', 'see https://example.com');
    expect(sentContent().linkPreview).toBeNull();
  });
});

// A caller-supplied preview short-circuits generation: with the key present Baileys never calls
// getUrlInfo, so nothing is fetched and a preview can be attached for a URL this server cannot reach.
describe('BaileysAdapter custom link preview', () => {
  beforeEach(() => {
    fakeSock.user = undefined;
    fakeSock.resetEmitter();
    jest.clearAllMocks();
  });

  const readyAdapter = async () => {
    const adapter = newAdapter();
    await adapter.initialize(noopCallbacks({}));
    fakeSock.user = { id: '628999:12@s.whatsapp.net', name: 'Me' };
    fakeSock.fire('connection.update', { connection: 'open' });
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 });
    return adapter;
  };

  const sentContent = (): Record<string, unknown> =>
    (fakeSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>])[1];

  it('maps the supplied metadata into the shape WhatsApp expects', async () => {
    const adapter = await readyAdapter();

    await adapter.sendTextMessage('628111@c.us', 'see https://example.com', undefined, {
      customPreview: { url: 'https://example.com', title: 'Example', description: 'A site' },
    });

    expect(sentContent().linkPreview).toEqual({
      'matched-text': 'https://example.com',
      'canonical-url': 'https://example.com',
      title: 'Example',
      description: 'A site',
    });
  });

  it('omits a description that was not supplied', async () => {
    const adapter = await readyAdapter();

    await adapter.sendTextMessage('628111@c.us', 'x', undefined, {
      customPreview: { url: 'https://example.com', title: 'Example' },
    });

    expect(sentContent().linkPreview).not.toHaveProperty('description');
  });
});

/**
 * A status voice note differs from a status audio file by one flag, and Baileys applies no
 * validation: `{ audio, ptt }` is copied into the proto as given. So the shape of the content this
 * builds is the whole behaviour, and it is invisible at runtime — a wrong flag still sends.
 */
describe('BaileysAdapter voice status', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'S1' }, messageTimestamp: 1700000006 });
  });

  const ready = async (): Promise<BaileysAdapter> => {
    const adapter = newAdapter();
    await adapter.initialize({});
    fakeSock.fire('connection.update', { connection: 'open' });
    return adapter;
  };

  it('sends audio with ptt set, to the status broadcast, for exactly the recipients given', async () => {
    const adapter = await ready();

    await adapter.postVoiceStatus(
      { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('audio').toString('base64') },
      { recipients: ['628111@c.us'] },
    );

    const [chatId, content, options] = fakeSock.sendMessage.mock.calls[0] as [
      string,
      { audio?: unknown; ptt?: boolean; caption?: string },
      { statusJidList?: string[] },
    ];
    expect(chatId).toBe('status@broadcast');
    expect(content.ptt).toBe(true);
    expect(content.audio).toBeDefined();
    expect(options.statusJidList).toEqual(['628111@s.whatsapp.net']);
  });

  // WhatsApp has nowhere to render a caption on a status voice note.
  it('carries no caption', async () => {
    const adapter = await ready();

    await adapter.postVoiceStatus(
      { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('audio').toString('base64'), caption: 'ignored' },
      { recipients: ['628111@c.us'], caption: 'also ignored' },
    );

    const [, content] = fakeSock.sendMessage.mock.calls[0] as [string, { caption?: string }];
    expect(content.caption).toBeUndefined();
  });

  // Baileys posts to exactly statusJidList, so an empty one would publish to nobody.
  it('still refuses an empty recipients list', async () => {
    const adapter = await ready();

    await expect(
      adapter.postVoiceStatus({ mimetype: 'audio/ogg; codecs=opus', data: 'QUJD' }, { recipients: [] }),
    ).rejects.toThrow(/recipients is required/);
  });
});
