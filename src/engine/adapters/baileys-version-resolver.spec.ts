import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as BaileysLib from '@whiskeysockets/baileys';
import { BaileysVersionResolver, DEFAULT_FALLBACK_WA_VERSION, WAVersion } from './baileys-version-resolver';

describe('BaileysVersionResolver', () => {
  let tmpDir: string;
  let mockLogger: { log: jest.Mock; warn: jest.Mock };

  beforeEach(() => {
    delete process.env.BAILEYS_WA_VERSION;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-ver-test-'));
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
    };
  });

  afterEach(() => {
    delete process.env.BAILEYS_WA_VERSION;
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup in os.tmpdir
    }
  });

  const createResolver = (timeoutMs?: number) =>
    new BaileysVersionResolver({
      authDir: tmpDir,
      sessionId: 'test-session',
      logger: mockLogger,
      timeoutMs,
    });

  const asBaileysLib = (mock: unknown): typeof BaileysLib => mock as typeof BaileysLib;

  describe('Session proxy', () => {
    // Every supported proxy scheme now has a fetch transport, so the lookup rides the proxy instead
    // of being skipped for want of one.
    it('hands the dispatcher to the remote tier rather than skipping it', async () => {
      const dispatcher = { marker: 'session-proxy' };
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({ isLatest: true, version: [2, 3000, 1043857760] }),
        fetchLatestBaileysVersion: jest.fn(),
      };

      const version = await resolver.resolve(asBaileysLib(mockLib), { dispatcher });

      expect(version).toEqual([2, 3000, 1043857760]);
      expect(mockLib.fetchLatestWaWebVersion).toHaveBeenCalledWith(expect.objectContaining({ dispatcher }));
    });
  });

  describe('Tier 1: BAILEYS_WA_VERSION environment variable override', () => {
    it('when BAILEYS_WA_VERSION is set in dot format, returns the overridden version immediately without network calls', async () => {
      // Arrange
      process.env.BAILEYS_WA_VERSION = '2.3000.1045340097';
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn(),
        fetchLatestBaileysVersion: jest.fn(),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 1045340097]);
      expect(mockLib.fetchLatestWaWebVersion).not.toHaveBeenCalled();
      expect(mockLib.fetchLatestBaileysVersion).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith('Using BAILEYS_WA_VERSION override: 2.3000.1045340097', {
        sessionId: 'test-session',
      });
    });

    it('when BAILEYS_WA_VERSION is set in comma format, parses and returns the version', async () => {
      // Arrange
      process.env.BAILEYS_WA_VERSION = '2,3000,1045340097';
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn(),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 1045340097]);
      expect(mockLogger.log).toHaveBeenCalledWith('Using BAILEYS_WA_VERSION override: 2.3000.1045340097', {
        sessionId: 'test-session',
      });
    });

    it('when BAILEYS_WA_VERSION is malformed (e.g. missing patch), logs warning and falls through to next tier', async () => {
      // Arrange
      process.env.BAILEYS_WA_VERSION = '2.3000';
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1045345293],
          isLatest: true,
        }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 1045345293]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid BAILEYS_WA_VERSION'), {
        sessionId: 'test-session',
      });
    });

    it('when BAILEYS_WA_VERSION has unreasonable numbers (e.g. 1.2.3), logs warning and falls through', async () => {
      // Arrange
      process.env.BAILEYS_WA_VERSION = '1.2.3';
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1045345293],
          isLatest: true,
        }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 1045345293]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid BAILEYS_WA_VERSION'), {
        sessionId: 'test-session',
      });
    });
  });

  describe('Tier 2: fetchLatestWaWebVersion (live WhatsApp Web service worker)', () => {
    it('when fetchLatestWaWebVersion succeeds (isLatest=true), returns version, persists to disk cache, and forwards dispatcher', async () => {
      // Arrange
      const resolver = createResolver();
      const mockDispatcher = { id: 'mock-proxy-dispatcher' };
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1045345293],
          isLatest: true,
        }),
        fetchLatestBaileysVersion: jest.fn(),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib), { dispatcher: mockDispatcher });

      // Assert
      expect(version).toEqual([2, 3000, 1045345293]);
      expect(mockLib.fetchLatestWaWebVersion).toHaveBeenCalledTimes(1);
      const fnMock = mockLib.fetchLatestWaWebVersion as jest.Mock<Promise<unknown>, [Record<string, unknown>?]>;
      const callOptions = fnMock.mock.calls[0]?.[0];
      expect(callOptions?.dispatcher).toBe(mockDispatcher);
      expect(callOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(mockLib.fetchLatestBaileysVersion).not.toHaveBeenCalled();

      // Verify disk cache was saved
      const cachePath = path.join(tmpDir, 'last_known_wa_version.json');
      expect(fs.existsSync(cachePath)).toBe(true);
      const rawCache: string = fs.readFileSync(cachePath, 'utf8');
      const cacheContent: unknown = JSON.parse(rawCache);
      expect(cacheContent).toEqual([2, 3000, 1045345293]);
    });

    it('when fetchLatestWaWebVersion returns Baileys error stub (isLatest=false), does NOT write to cache and advances to Tier 3', async () => {
      // Arrange
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760], // Baileys frozen stub
          isLatest: false,
          error: new Error('fetch error'),
        }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: true,
        }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 1043857760]);
      expect(mockLib.fetchLatestBaileysVersion).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('fetchLatestWaWebVersion returned isLatest=false'),
        { sessionId: 'test-session' },
      );
    });

    it('when fetchLatestWaWebVersion rejects, logs warning and advances to Tier 3', async () => {
      // Arrange
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockRejectedValue(new Error('Network offline')),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: true,
        }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 1043857760]);
      expect(mockLib.fetchLatestBaileysVersion).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('fetchLatestWaWebVersion failed: Network offline'),
        { sessionId: 'test-session' },
      );
    });
  });

  describe('Tier 3: fetchLatestBaileysVersion (upstream repository Defaults/index.ts)', () => {
    it('when Tier 2 returns isLatest=false and Tier 3 succeeds (isLatest=true), returns version and persists to disk cache', async () => {
      // Arrange
      const resolver = createResolver();
      const mockDispatcher = { id: 'mock-proxy-agent' };
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: false,
        }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: true,
        }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib), { dispatcher: mockDispatcher });

      // Assert
      expect(version).toEqual([2, 3000, 1043857760]);
      expect(mockLib.fetchLatestBaileysVersion).toHaveBeenCalledWith({
        dispatcher: mockDispatcher,
      });

      const cachePath = path.join(tmpDir, 'last_known_wa_version.json');
      expect(fs.existsSync(cachePath)).toBe(true);
      const rawCache: string = fs.readFileSync(cachePath, 'utf8');
      const cacheContent: unknown = JSON.parse(rawCache);
      expect(cacheContent).toEqual([2, 3000, 1043857760]);
    });

    it('when fetchLatestBaileysVersion returns isLatest=false, does NOT poison disk cache and advances to Tier 4', async () => {
      // Arrange: Seed good cached value from a previous run
      const cachePath = path.join(tmpDir, 'last_known_wa_version.json');
      const seededVersion: WAVersion = [2, 3000, 1045340097];
      fs.writeFileSync(cachePath, JSON.stringify(seededVersion), 'utf8');

      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: false,
        }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: false,
        }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert: Good seeded cache must NOT be overwritten by the Baileys frozen stub
      expect(version).toEqual(seededVersion);
      const rawCache: string = fs.readFileSync(cachePath, 'utf8');
      const cacheContent: unknown = JSON.parse(rawCache);
      expect(cacheContent).toEqual(seededVersion);
      expect(mockLogger.warn).toHaveBeenCalledWith('Using cached WhatsApp Web version from disk: 2.3000.1045340097', {
        sessionId: 'test-session',
      });
    });

    it('when fetchLatestBaileysVersion hangs, timeout race aborts and advances to Tier 4 (disk cache)', async () => {
      // Arrange: Seed cache
      const cachePath = path.join(tmpDir, 'last_known_wa_version.json');
      const seededVersion: WAVersion = [2, 3000, 999999];
      fs.writeFileSync(cachePath, JSON.stringify(seededVersion), 'utf8');

      // Use a fast 50ms timeout for test
      const resolver = createResolver(50);
      const hangingPromise = new Promise<{ version: WAVersion; isLatest: boolean }>(() => {});
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({
          version: [2, 3000, 1043857760],
          isLatest: false,
        }),
        fetchLatestBaileysVersion: jest.fn().mockReturnValue(hangingPromise),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual(seededVersion);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('fetchLatestBaileysVersion failed: fetchLatestBaileysVersion timeout'),
        { sessionId: 'test-session' },
      );
    });
  });

  describe('Tier 4: Local disk cache', () => {
    it('when remote fetches fail and valid disk cache exists, returns cached version', async () => {
      // Arrange
      const cachePath = path.join(tmpDir, 'last_known_wa_version.json');
      fs.writeFileSync(cachePath, JSON.stringify([2, 3000, 888888]), 'utf8');

      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({ isLatest: false }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ isLatest: false }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual([2, 3000, 888888]);
      expect(mockLogger.warn).toHaveBeenCalledWith('Using cached WhatsApp Web version from disk: 2.3000.888888', {
        sessionId: 'test-session',
      });
    });

    it('when disk cache contains corrupt JSON, falls through to Tier 5', async () => {
      // Arrange
      const cachePath = path.join(tmpDir, 'last_known_wa_version.json');
      fs.writeFileSync(cachePath, '{ corrupt json', 'utf8');

      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({ isLatest: false }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ isLatest: false }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual(DEFAULT_FALLBACK_WA_VERSION);
    });
  });

  describe('Tier 5: DEFAULT_FALLBACK_WA_VERSION', () => {
    it('when all remote fetches fail and disk cache is missing, returns DEFAULT_FALLBACK_WA_VERSION and logs warning', async () => {
      // Arrange
      const resolver = createResolver();
      const mockLib = {
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({ isLatest: false }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ isLatest: false }),
      };

      // Act
      const version = await resolver.resolve(asBaileysLib(mockLib));

      // Assert
      expect(version).toEqual(DEFAULT_FALLBACK_WA_VERSION);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('using fallback WhatsApp Web version: 2.3000.1045340097'),
        { sessionId: 'test-session' },
      );
    });
  });
});
