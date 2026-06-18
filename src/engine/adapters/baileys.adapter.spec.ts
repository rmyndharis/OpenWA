import { EventEmitter } from 'events';

jest.mock('../../common/media/load-remote-media', () => ({
  loadRemoteMediaBuffer: jest.fn(),
}));

// A fake Baileys socket: an event emitter wearing the methods the adapter calls.
class FakeSock extends EventEmitter {
  public ev = {
    on: (event: string, handler: (arg: unknown) => void) => {
      this.emitter.on(event, handler);
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
  downloadMediaMessage: jest.fn().mockResolvedValue(Buffer.from('IMGDATA')),
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

  it('getNumberId resolves via onWhatsApp and returns the jid when it exists', async () => {
    fakeSock.onWhatsApp.mockResolvedValue([{ jid: '628111@s.whatsapp.net', exists: true }]);
    const adapter = await readyAdapter();
    await expect(adapter.getNumberId('628111')).resolves.toBe('628111@s.whatsapp.net');
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
  const baileys = jest.requireMock('@whiskeysockets/baileys') as { getContentType: jest.Mock };

  beforeEach(() => {
    fakeSock.user = { id: '628999:1@s.whatsapp.net', name: 'Me' };
    fakeSock.resetEmitter();
    jest.clearAllMocks();
    baileys.getContentType.mockReturnValue('conversation');
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
    baileys.downloadMediaMessage.mockResolvedValue(imgBuf);

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

  it('inbound documentWithCaption: normalizeMessageContent unwraps wrapper, yields non-empty mimetype', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileys = jest.requireMock('@whiskeysockets/baileys') as {
      getContentType: jest.Mock;
      downloadMediaMessage: jest.Mock;
      normalizeMessageContent: jest.Mock;
    };
    baileys.getContentType.mockReturnValue('documentWithCaptionMessage');
    const docBuf = Buffer.from('PDFBYTES');
    baileys.downloadMediaMessage.mockResolvedValue(docBuf);
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
      media: { mimetype: string; filename?: string; data: string };
    };
    expect(msg.type).toBe('document');
    expect(msg.media.mimetype).toBe('application/pdf');
    expect(msg.media.filename).toBe('report.pdf');
    expect(msg.media.data).toBe(docBuf.toString('base64'));
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
      chatId: string;
      type: string;
      body: string;
    };
    expect(revoked.id).toBe('ORIGINAL_ID');
    expect(revoked.chatId).toBe('628111@s.whatsapp.net');
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
    expect(event.chatId).toBe('628111@s.whatsapp.net');
    expect(event.reaction).toBe('👍');
    expect(event.senderId).toBe('628111@s.whatsapp.net');
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

  it('resolves a base64 data string to a Buffer (no URL fetch)', async () => {
    const adapter = await ready();
    await adapter.sendDocumentMessage('628111@s.whatsapp.net', {
      mimetype: 'application/pdf',
      data: Buffer.from('PDFDATA').toString('base64'),
      filename: 'doc.pdf',
    });
    expect(loadRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(fakeSock.sendMessage).toHaveBeenCalledWith('628111@s.whatsapp.net', {
      document: Buffer.from('PDFDATA'),
      mimetype: 'application/pdf',
      fileName: 'doc.pdf',
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
    expect(contacts[0]).toMatchObject({ id: '628111@s.whatsapp.net', pushName: 'Al', number: '628111' });
    expect((await adapter.getContactById('628111@s.whatsapp.net'))?.number).toBe('628111');
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
      id: '628111@s.whatsapp.net',
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

describe('BaileysAdapter sendSeen + deleteChat', () => {
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
