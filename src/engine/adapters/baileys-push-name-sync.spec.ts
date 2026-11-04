import { EventEmitter } from 'events';

type Me = { id: string; lid?: string; name?: string };

// A fake Baileys socket: the adapter listens through `ev`, and `user` is the live creds.me, as in Baileys.
class FakeSock {
  readonly emitter = new EventEmitter();
  readonly ev = {
    on: (event: string, handler: (arg: unknown) => void): void => {
      this.emitter.on(event, handler);
    },
    removeAllListeners: (event: string): void => {
      this.emitter.removeAllListeners(event);
    },
  };
  readonly ws = Object.assign(new EventEmitter(), { isOpen: true, isConnecting: false });
  readonly end = jest.fn();
  readonly authState = { creds: { accountSyncCounter: 1, account: {}, me: undefined as Me | undefined }, keys: {} };
  readonly fetchAccountReachoutTimelock = jest.fn().mockResolvedValue({ isActive: false });
  readonly groupFetchAllParticipating = jest.fn().mockResolvedValue({});
  readonly resyncAppState = jest.fn().mockResolvedValue(undefined);
  get user(): Me | undefined {
    return this.authState.creds.me;
  }
  /** Baileys assigns a creds update into the live creds and then emits it. */
  credsUpdate(update: { me?: Me; accountSyncCounter?: number }): void {
    Object.assign(this.authState.creds, update);
    this.emitter.emit('creds.update', update);
  }
  fire(event: string, arg: unknown): void {
    this.emitter.emit(event, arg);
  }
}

let mockSock = new FakeSock();

jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(() => mockSock),
  makeCacheableSignalKeyStore: jest.fn((store: unknown) => store),
  DisconnectReason: { loggedOut: 401, forbidden: 403, restartRequired: 515, connectionReplaced: 440 },
  ALL_WA_PATCH_NAMES: [],
}));
jest.mock('./baileys-auth-store', () => ({
  useAtomicMultiFileAuthState: jest.fn(() =>
    Promise.resolve({ state: mockSock.authState, saveCreds: jest.fn().mockResolvedValue(undefined) }),
  ),
}));

import { BaileysAdapter } from './baileys.adapter';

const ACCOUNT = '628999:12@s.whatsapp.net';

/**
 * WhatsApp hands a personal account's name to a new link only after the connection opened: pair-success
 * stores the business name (none for a personal account), and the name arrives later as a creds update
 * (an app-state push name setting or an own message). The adapter reports it then, without a second ready.
 */
async function linkedAdapter(me: Me = { id: ACCOUNT }) {
  mockSock = new FakeSock();
  mockSock.authState.creds.me = me;
  const onReady = jest.fn();
  const onPushNameChanged = jest.fn();
  const adapter = new BaileysAdapter({
    sessionId: 'push-name',
    dbSessionId: 'push-name-db',
    authDir: '/nonexistent/openwa-push-name-spec',
    messageStore: {
      put: jest.fn(),
      getMessage: jest.fn(),
      getMessages: jest.fn().mockResolvedValue([]),
      clearSession: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    },
  });
  await adapter.initialize({ onReady, onPushNameChanged });
  return { adapter, onReady, onPushNameChanged };
}

describe('the push name a newly linked Baileys account syncs after the connection opened', () => {
  const version = process.env.BAILEYS_WA_VERSION;
  // Skips the remote version lookup and the disk cache it writes.
  beforeAll(() => {
    process.env.BAILEYS_WA_VERSION = '2.3000.1';
  });
  afterAll(() => {
    if (version === undefined) delete process.env.BAILEYS_WA_VERSION;
    else process.env.BAILEYS_WA_VERSION = version;
  });

  it('is reported once and read back, after a ready that carried none', async () => {
    const { adapter, onReady, onPushNameChanged } = await linkedAdapter();
    mockSock.fire('connection.update', { connection: 'open' });
    expect(onReady).toHaveBeenCalledWith('628999', '');
    expect(adapter.getPushName()).toBeNull();

    mockSock.credsUpdate({ me: { id: ACCOUNT, name: 'Synced Later' } });

    expect(adapter.getPushName()).toBe('Synced Later');
    expect(onPushNameChanged.mock.calls).toEqual([['Synced Later']]);
    expect(onReady).toHaveBeenCalledTimes(1);

    // The same name again, and an update that names nobody, change nothing.
    mockSock.credsUpdate({ me: { id: ACCOUNT, name: 'Synced Later' } });
    mockSock.credsUpdate({ accountSyncCounter: 2 });
    mockSock.credsUpdate({ me: { id: ACCOUNT, name: '' } });
    expect(onPushNameChanged).toHaveBeenCalledTimes(1);
    expect(adapter.getPushName()).toBe('Synced Later');
  });

  it('follows a later rename while ready', async () => {
    const { adapter, onPushNameChanged } = await linkedAdapter({ id: ACCOUNT, name: 'First' });
    mockSock.fire('connection.update', { connection: 'open' });

    mockSock.credsUpdate({ me: { id: ACCOUNT, name: 'Renamed' } });

    expect(onPushNameChanged.mock.calls).toEqual([['Renamed']]);
    expect(adapter.getPushName()).toBe('Renamed');
  });

  it('is left to the ready event when it syncs before the connection opened', async () => {
    const { adapter, onReady, onPushNameChanged } = await linkedAdapter();

    mockSock.credsUpdate({ me: { id: ACCOUNT, name: 'Before Open' } });
    mockSock.fire('connection.update', { connection: 'open' });

    expect(onPushNameChanged).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith('628999', 'Before Open');
    expect(adapter.getPushName()).toBe('Before Open');
  });
});
