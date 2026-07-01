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
  public sendMessage = jest.fn();
  public onWhatsApp = jest.fn();
  public sendPresenceUpdate = jest.fn().mockResolvedValue(undefined);
  public groupFetchAllParticipating = jest.fn();
  public groupMetadata = jest.fn();
  public groupCreate = jest.fn();
  public groupParticipantsUpdate = jest.fn().mockResolvedValue(undefined);
  public groupLeave = jest.fn().mockResolvedValue(undefined);
  public groupUpdateSubject = jest.fn().mockResolvedValue(undefined);
  public groupUpdateDescription = jest.fn().mockResolvedValue(undefined);
  public groupInviteCode = jest.fn();
  public groupRevokeInvite = jest.fn();
  public profilePictureUrl = jest.fn();
  public updateBlockStatus = jest.fn().mockResolvedValue(undefined);
  public readMessages = jest.fn().mockResolvedValue(undefined);
  public chatModify = jest.fn().mockResolvedValue(undefined);
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
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  proto: {
    Message: {
      ProtocolMessage: {
        Type: { REVOKE: 0 },
      },
    },
  },
}));

import { BaileysAdapter } from './baileys.adapter';
import { EngineStatus, EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
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
const newAdapter = (): BaileysAdapter =>
  new BaileysAdapter({ sessionId: 'sess-1', authDir: './data/baileys', messageStore: fakeStore });

const noopCallbacks = (over: Partial<EngineEventCallbacks> = {}): EngineEventCallbacks => over;

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
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onDisconnected).toHaveBeenCalled();
    expect(makeWASocket).not.toHaveBeenCalled(); // no reconnect
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

  it('logout() clears the on-disk auth dir (stale creds would otherwise block re-linking)', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    try {
      const adapter = newAdapter();
      await adapter.initialize(noopCallbacks({}));
      await adapter.logout();
      expect(rmSpy).toHaveBeenCalledWith(
        path.join('./data/baileys', 'sess-1'),
        expect.objectContaining({ recursive: true, force: true }),
      );
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

    // Reconnect is now backoff-delayed (1 s on first attempt): use fake timers to advance.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      fakeSock.fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 515 } } },
      });
      jest.advanceTimersByTime(1_000);
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
});

describe('BaileysAdapter lifecycle hardening — I4 reconnect backoff', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const baileys = () => jest.requireMock('@whiskeysockets/baileys') as { default: jest.Mock };

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
    // Ensure fake timers are always cleaned up even if a test fails mid-way.
    jest.useRealTimers();
  });

  it('I4: after MAX_RECONNECT_ATTEMPTS recoverable closes → FAILED + onError, no more reconnects', async () => {
    const onError = jest.fn();
    const adapter = await initWithRealTimers({ onError });

    // Switch to fake timers AFTER initialize() has resolved.
    jest.useFakeTimers();

    // Each close increments reconnectAttempts and schedules a timer.
    // After the timer fires, connect() calls makeWASocket() which resets the emitter,
    // so each reconnect cycle has exactly one listener — no accumulation across attempts.
    // Strategy: fire close → run timers (reconnect executes, emitter reset) → fire close again → repeat.
    for (let i = 0; i < 5 /* MAX_RECONNECT_ATTEMPTS */; i++) {
      fireRecoverableClose();
      await jest.runAllTimersAsync();
    }

    // The (MAX+1)th close — reconnectAttempts is now MAX (5) → exhausted path:
    // no reconnect scheduled, status → FAILED, onError fired exactly once.
    fireRecoverableClose();
    await jest.runAllTimersAsync();

    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('exhausted'));
  });

  it('I4: successful connection resets the reconnect counter (next drop can reconnect again)', async () => {
    const onError = jest.fn();
    const adapter = await initWithRealTimers({ onError });

    jest.useFakeTimers();

    // Fire one recoverable drop and reconnect — increments counter to 1
    fireRecoverableClose();
    await jest.runAllTimersAsync();

    // Simulate a successful open — should reset the reconnect counter to 0
    fakeSock.fire('connection.update', { connection: 'open' });
    expect(adapter.getStatus()).toBe(EngineStatus.READY);

    // Now exhaust MAX_RECONNECT_ATTEMPTS again — should work because counter was reset
    for (let i = 0; i < 5 /* MAX_RECONNECT_ATTEMPTS */; i++) {
      fireRecoverableClose();
      await jest.runAllTimersAsync();
    }

    // (MAX+1)th drop after reset → FAILED again, onError fired exactly once
    fireRecoverableClose();
    await jest.runAllTimersAsync();

    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('exhausted'));
  });

  it('I4: a recoverable close after disconnect() (intentionalClose) does NOT schedule a reconnect', async () => {
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

  it('I4: backoff timers are used — first reconnect is delayed ~1 s (not immediate)', async () => {
    await initWithRealTimers({});
    baileys().default.mockClear();

    jest.useFakeTimers({ doNotFake: ['setImmediate'] });

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

describe('BaileysAdapter capability gating', () => {
  it('throws EngineNotSupportedError for still-gated methods (e.g. getChatHistory)', async () => {
    const adapter = newAdapter();
    await expect(adapter.getChatHistory('628111@s.whatsapp.net')).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
});

describe('BaileysAdapter location + contact sends', () => {
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
});

describe('BaileysAdapter messaging', () => {
  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
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
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', { text: 'hello' });
    expect(res).toEqual({ id: 'OUT1', timestamp: 1700000001 });
  });

  it('sendTextMessage honors the chat disappearing timer when one is cached (#473)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    fakeSock.fire('chats.upsert', [{ id: '628111@s.whatsapp.net', ephemeralExpiration: 604800 }]);
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    expect(fakeSock.sendMessage).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      { text: 'hello' },
      { ephemeralExpiration: 604800 },
    );
  });

  it('sendTextMessage de-normalizes mentions to engine jids (#530)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    await adapter.sendTextMessage('120@g.us', 'hi @62811', ['62811@c.us']);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('120@g.us', {
      text: 'hi @62811',
      mentions: ['62811@s.whatsapp.net'],
    });
  });

  it('sendTextMessage omits the mentions key when none are given (no behavior change)', async () => {
    fakeSock.sendMessage.mockResolvedValue({ key: { id: 'OUT1' }, messageTimestamp: 1700000001 });
    const adapter = await readyAdapter();
    await adapter.sendTextMessage('120@g.us', 'plain', []);
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('120@g.us', { text: 'plain' });
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
    // No history-sync mapping this time; the inbound key itself carries senderLid + senderPn,
    // which is the only place a fresh @lid sender's number is revealed in baileys@6.7.23.
    fakeSock.fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '111@lid',
            fromMe: false,
            id: 'IN_LID_KEY',
            senderLid: '111@lid',
            senderPn: '628111@s.whatsapp.net',
          },
          message: { conversation: 'hi from lid' },
          messageTimestamp: 1700000005,
        },
      ],
    });
    await new Promise(r => setImmediate(r));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const msg = onMessage.mock.calls[0][0] as { from: string; isLidSender?: boolean };
    expect(msg.from).toBe('628111@c.us'); // resolved from the key's senderPn, neutral dialect
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

  it('ignores append (history) upserts', async () => {
    const onMessage = jest.fn();
    const adapter = newAdapter();
    await adapter.initialize({ onMessage });
    fakeSock.fire('messages.upsert', {
      type: 'append',
      messages: [
        { key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'OLD' }, message: { conversation: 'old' } },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
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

  it('replyToMessage quotes the stored message', async () => {
    fakeStore.getMessage.mockResolvedValue(stored);
    const adapter = await ready();
    await adapter.replyToMessage('628111@s.whatsapp.net', 'TARGET', 'my reply');
    expect(fakeStore.getMessage).toHaveBeenCalledWith('sess-1', 'TARGET');
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

  it('deleteMessage for-me (forEveryone=false) is not supported', async () => {
    const adapter = await ready();
    await expect(adapter.deleteMessage('c', 'TARGET', false)).rejects.toBeInstanceOf(EngineNotSupportedError);
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
    expect(fakeStore.put).toHaveBeenCalledWith('sess-1', inboundMatcher);
  });

  it('populates the store on an outgoing send', async () => {
    const adapter = await ready();
    await adapter.sendTextMessage('628111@s.whatsapp.net', 'hello');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const outboundMatcher = expect.objectContaining({ key: expect.objectContaining({ id: 'OUT' }) });
    expect(fakeStore.put).toHaveBeenCalledWith('sess-1', outboundMatcher);
  });

  it('clears the store on logout', async () => {
    const adapter = await ready();
    await adapter.logout();
    expect(fakeStore.clearSession).toHaveBeenCalledWith('sess-1');
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

  it('getGroupInfo maps groupMetadata, and returns null when it rejects', async () => {
    fakeSock.groupMetadata.mockResolvedValueOnce(META);
    const adapter = await ready();
    expect((await adapter.getGroupInfo('123-456@g.us'))?.id).toBe('123-456@g.us');
    fakeSock.groupMetadata.mockRejectedValueOnce(new Error('not a group'));
    expect(await adapter.getGroupInfo('x@g.us')).toBeNull();
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

  it('group ops reject with EngineNotReadyError before connect', async () => {
    const adapter = newAdapter();
    await adapter.initialize({});
    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
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
