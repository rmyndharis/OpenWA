import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { BrowserSession } from './entities/browser-session.entity';
import { AuthService, UnresolvedApiKeyException } from './auth.service';
import { BrowserSessionService } from './browser-session.service';
import { BrowserSessionController } from './browser-session.controller';
import { HEADER_AUTH_ONLY_KEY, PUBLIC_KEY } from './decorators/auth.decorators';
import {
  DEFAULT_BROWSER_SESSION_TTL_MS,
  MAX_BROWSER_SESSION_TTL_MS,
  MIN_BROWSER_SESSION_TTL_MS,
  assertBrowserCsrfSafe,
  extractBrowserSessionCookie,
  formatSessionClearCookie,
  formatSessionSetCookie,
  isAllowedBrowserOrigin,
  isAllowedBrowserWsHandshake,
  isCookieAuthDisallowedPath,
  isSecureCookieRequest,
  resolveBrowserSessionTtlMs,
} from './browser-session.util';
import { CreateBrowserSessions1792000000000 } from '../../database/migrations-main/1792000000000-CreateBrowserSessions';
import { hashApiKey } from './api-key-hash';
import type { ActiveKeyIndex } from './active-key-index';
import type { EngineFactory } from '../../engine/engine.factory';
import { EventsGateway } from '../events/events.gateway';

describe('browser-session.util', () => {
  const savedSecure = process.env.DASHBOARD_SESSION_COOKIE_SECURE;

  afterEach(() => {
    if (savedSecure === undefined) delete process.env.DASHBOARD_SESSION_COOKIE_SECURE;
    else process.env.DASHBOARD_SESSION_COOKIE_SECURE = savedSecure;
  });

  it('bounds DASHBOARD_SESSION_TTL_MS within safe minimum and maximum limits', () => {
    expect(resolveBrowserSessionTtlMs(undefined)).toBe(DEFAULT_BROWSER_SESSION_TTL_MS);
    expect(resolveBrowserSessionTtlMs('abc')).toBe(DEFAULT_BROWSER_SESSION_TTL_MS);
    expect(resolveBrowserSessionTtlMs('0')).toBe(DEFAULT_BROWSER_SESSION_TTL_MS);
    expect(resolveBrowserSessionTtlMs('1000')).toBe(MIN_BROWSER_SESSION_TTL_MS);
    expect(resolveBrowserSessionTtlMs(String(MAX_BROWSER_SESSION_TTL_MS * 10))).toBe(MAX_BROWSER_SESSION_TTL_MS);
    expect(resolveBrowserSessionTtlMs(String(60 * 60 * 1000))).toBe(60 * 60 * 1000);
  });

  it('parses openwa_session from single, multi-cookie, quoted, and URL-encoded Cookie headers', () => {
    expect(extractBrowserSessionCookie(undefined)).toBeUndefined();
    expect(extractBrowserSessionCookie('other=1; theme=dark')).toBeUndefined();
    expect(extractBrowserSessionCookie('openwa_session=')).toBeUndefined();
    expect(extractBrowserSessionCookie('theme=dark; openwa_session=abc_123-XYZ; path=/')).toBe('abc_123-XYZ');
    expect(extractBrowserSessionCookie('openwa_session="quoted%2Btok"')).toBe('quoted+tok');
    expect(extractBrowserSessionCookie(['a=1', 'openwa_session=from-array'])).toBe('from-array');
  });

  it('classifies header-only API surfaces as cookie-disallowed even with duplicate slashes or percent-encoding', () => {
    expect(isCookieAuthDisallowedPath('/mcp')).toBe(true);
    expect(isCookieAuthDisallowedPath('/mcp/sse')).toBe(true);
    expect(isCookieAuthDisallowedPath('///mcp//sse')).toBe(true);
    expect(isCookieAuthDisallowedPath('/%6dcp')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/metrics')).toBe(true);
    expect(isCookieAuthDisallowedPath('//api///metrics')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/%6detrics')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/metrics/prometheus')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/admin/queues')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/admin//queues/ui')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/admin/%71ueues')).toBe(true);
    expect(isCookieAuthDisallowedPath('/api/sessions')).toBe(false);
    expect(isCookieAuthDisallowedPath('/api/auth/session')).toBe(false);
  });

  it('computes Secure attribute from env override, direct TLS, or rightmost trusted-proxy X-Forwarded-Proto', () => {
    delete process.env.DASHBOARD_SESSION_COOKIE_SECURE;

    expect(isSecureCookieRequest({ secure: true, headers: {} }, [])).toBe(true);
    expect(isSecureCookieRequest({ secure: false, headers: { 'x-forwarded-proto': 'https' } }, [])).toBe(false);

    // Untrusted peer spoofing X-Forwarded-Proto is ignored.
    expect(
      isSecureCookieRequest(
        {
          secure: false,
          socket: { remoteAddress: '198.51.100.10' },
          headers: { 'x-forwarded-proto': 'https' },
        },
        ['10.0.0.1'],
      ),
    ).toBe(false);

    // Client spoofed "https" before a plain-HTTP trusted proxy appended ", http": rightmost entry wins (false).
    expect(
      isSecureCookieRequest(
        {
          secure: false,
          socket: { remoteAddress: '10.0.0.1' },
          headers: { 'x-forwarded-proto': 'https, http' },
        },
        ['10.0.0.1'],
      ),
    ).toBe(false);

    // Trusted TLS-terminating proxy appending ", https" sets Secure (rightmost entry wins).
    expect(
      isSecureCookieRequest(
        {
          secure: false,
          socket: { remoteAddress: '10.0.0.1' },
          headers: { 'x-forwarded-proto': 'http, https' },
        },
        ['10.0.0.1'],
      ),
    ).toBe(true);

    process.env.DASHBOARD_SESSION_COOKIE_SECURE = 'true';
    expect(isSecureCookieRequest({ secure: false, headers: {} }, [])).toBe(true);

    process.env.DASHBOARD_SESSION_COOKIE_SECURE = 'false';
    expect(isSecureCookieRequest({ secure: true, headers: {} }, [])).toBe(false);
  });

  it('formats HttpOnly SameSite=Strict Set-Cookie headers for set and clear', () => {
    expect(formatSessionSetCookie('tok123', 3600, false)).toBe(
      'openwa_session=tok123; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600',
    );
    expect(formatSessionSetCookie('tok123', 3600, true)).toBe(
      'openwa_session=tok123; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600; Secure',
    );
    expect(formatSessionClearCookie(true)).toBe(
      'openwa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure',
    );
  });

  it('validates browser origins against host, default ports, scheme, and explicit CORS_ORIGINS without allowing wildcard', () => {
    expect(
      isAllowedBrowserOrigin('https://wa.example.com', 'wa.example.com', undefined, 'production', true, 'https:'),
    ).toBe(true);
    expect(
      isAllowedBrowserOrigin('https://wa.example.com', 'wa.example.com:443', undefined, 'production', true, 'https:'),
    ).toBe(true);
    expect(
      isAllowedBrowserOrigin('http://wa.example.com', 'wa.example.com:80', undefined, 'production', true, 'http:'),
    ).toBe(true);
    // Scheme mismatch on HTTPS/WSS is rejected.
    expect(
      isAllowedBrowserOrigin('http://wa.example.com', 'wa.example.com', undefined, 'production', true, 'https:'),
    ).toBe(false);
    expect(isAllowedBrowserOrigin('https://evil.example', 'wa.example.com', '*', 'development', true, 'https:')).toBe(
      false,
    );
    expect(
      isAllowedBrowserOrigin(
        'https://ui.example.com',
        'api.example.com',
        'https://ui.example.com',
        'production',
        true,
        'https:',
      ),
    ).toBe(true);
    expect(isAllowedBrowserOrigin(undefined, 'wa.example.com', undefined, 'production', true, 'https:')).toBe(false);
    expect(isAllowedBrowserOrigin(undefined, 'wa.example.com', undefined, 'production', false, 'https:')).toBe(true);
  });

  it('allows https Origin over plain HTTP behind TLS-terminating proxy without TRUSTED_PROXIES and decouples DASHBOARD_SESSION_COOKIE_SECURE', () => {
    delete process.env.DASHBOARD_SESSION_COOKIE_SECURE;

    // Standard nginx/Caddy/Traefik TLS terminator -> plain HTTP backend, TRUSTED_PROXIES=[].
    expect(() =>
      assertBrowserCsrfSafe(
        {
          method: 'POST',
          secure: false,
          headers: {
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
            'sec-fetch-site': 'same-origin',
            'x-requested-with': 'OpenWA-Dashboard',
          },
        },
        [],
      ),
    ).not.toThrow();

    // DASHBOARD_SESSION_COOKIE_SECURE=false must not break https:// same-origin requests.
    process.env.DASHBOARD_SESSION_COOKIE_SECURE = 'false';
    expect(() =>
      assertBrowserCsrfSafe(
        {
          method: 'POST',
          secure: true,
          headers: {
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
            'sec-fetch-site': 'same-origin',
            'x-requested-with': 'OpenWA-Dashboard',
          },
        },
        [],
      ),
    ).not.toThrow();

    // DASHBOARD_SESSION_COOKIE_SECURE=true must not break http://localhost:2886 same-origin requests.
    process.env.DASHBOARD_SESSION_COOKIE_SECURE = 'true';
    expect(() =>
      assertBrowserCsrfSafe(
        {
          method: 'POST',
          secure: false,
          headers: {
            host: 'localhost:2886',
            origin: 'http://localhost:2886',
            'sec-fetch-site': 'same-origin',
            'x-requested-with': 'OpenWA-Dashboard',
          },
        },
        [],
      ),
    ).not.toThrow();

    // Direct HTTPS or trusted HTTPS proxy still rejects http:// downgrade Origin.
    delete process.env.DASHBOARD_SESSION_COOKIE_SECURE;
    expect(() =>
      assertBrowserCsrfSafe(
        {
          method: 'POST',
          secure: true,
          headers: {
            host: 'wa.example.com',
            origin: 'http://wa.example.com',
            'sec-fetch-site': 'same-origin',
            'x-requested-with': 'OpenWA-Dashboard',
          },
        },
        [],
      ),
    ).toThrow(ForbiddenException);

    expect(() =>
      assertBrowserCsrfSafe(
        {
          method: 'POST',
          secure: false,
          socket: { remoteAddress: '10.0.0.1' },
          headers: {
            host: 'wa.example.com',
            origin: 'http://wa.example.com',
            'x-forwarded-proto': 'http, https',
            'sec-fetch-site': 'same-origin',
            'x-requested-with': 'OpenWA-Dashboard',
          },
        },
        ['10.0.0.1'],
      ),
    ).toThrow(ForbiddenException);
  });

  it('validates cookie WebSocket handshakes including Origin-less same-origin polling GET requests', () => {
    // Modern browser same-origin Socket.IO HTTP polling GET omits Origin and sends Sec-Fetch-Site (+ optional Referer).
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: '127.0.0.1:2785',
            'sec-fetch-site': 'same-origin',
            referer: 'http://127.0.0.1:2785/sessions',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(true);
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: '127.0.0.1:2785',
            'sec-fetch-site': 'same-origin',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(true);

    // Sec-Fetch-Site: same-origin with a foreign, malformed, or downgraded Referer is rejected.
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: 'wa.example.com',
            'sec-fetch-site': 'same-origin',
            referer: 'https://evil.example/page',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(false);
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: true,
          headers: {
            host: 'wa.example.com',
            'sec-fetch-site': 'same-origin',
            referer: 'http://wa.example.com/sessions',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(false);
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: 'wa.example.com',
            'sec-fetch-site': 'same-origin',
            referer: 'not-a-valid-url',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(false);

    // Older browser without Fetch Metadata: same-origin Referer is allowed; foreign or HTTPS downgrade is rejected.
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: 'wa.example.com',
            referer: 'https://wa.example.com/sessions',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(true);
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: 'wa.example.com',
            referer: 'https://evil.example/sessions',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(false);
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: true,
          headers: {
            host: 'wa.example.com',
            referer: 'http://wa.example.com/sessions',
          },
        },
        [],
        undefined,
        'production',
      ),
    ).toBe(false);

    // Non-same-origin Sec-Fetch-Site (cross-site, same-site, none) is rejected without explicit CORS_ORIGINS even if Origin matches Host.
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(
        isAllowedBrowserWsHandshake(
          {
            secure: true,
            headers: {
              host: 'wa.example.com',
              origin: 'https://wa.example.com',
              'sec-fetch-site': site,
            },
          },
          [],
          undefined,
          'production',
        ),
      ).toBe(false);
    }
    // Explicit CORS_ORIGINS allows a cross-site browser handshake.
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: true,
          headers: {
            host: 'api.example.com',
            origin: 'https://ui.example.com',
            'sec-fetch-site': 'cross-site',
          },
        },
        [],
        'https://ui.example.com',
        'production',
      ),
    ).toBe(true);
    // Wildcard CORS never authorizes a cross-site cookie handshake.
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: {
            host: 'api.example.com',
            origin: 'https://evil.example',
            'sec-fetch-site': 'cross-site',
          },
        },
        [],
        '*',
        'development',
      ),
    ).toBe(false);

    // Header-stripped / non-browser cookie probe lacking Origin, Sec-Fetch-Site, and Referer is rejected.
    expect(
      isAllowedBrowserWsHandshake(
        {
          secure: false,
          headers: { host: 'wa.example.com' },
        },
        [],
        undefined,
        'development',
      ),
    ).toBe(false);
  });
});

describe('BrowserSessionService & CreateBrowserSessions migration (SQLite)', () => {
  let ds: DataSource;
  let authService: AuthService;
  let service: BrowserSessionService;
  let keyIndex: { refreshSoon: jest.Mock };
  let evictBrowserSession: jest.Mock;
  let moduleRef: ModuleRef;
  let activeKey: ApiKey;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, BrowserSession],
      synchronize: false,
    });
    await ds.initialize();
    const apiKeyRepo = ds.getRepository(ApiKey);
    const sessionRepo = ds.getRepository(BrowserSession);

    // Create api_keys schema via synchronize-compatible DDL and browser_sessions via the real migration.
    await ds.query(
      `CREATE TABLE "api_keys" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"keyHash" varchar(64) NOT NULL, ` +
        `"keyPrefix" varchar(12) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
        `"allowedSessions" text, ` +
        `"allowedChats" text, ` +
        `"allowedIps" text, ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"usageCount" integer NOT NULL DEFAULT (0), ` +
        `"lastUsedAt" datetime, ` +
        `"expiresAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    const qr = ds.createQueryRunner();
    const migration = new CreateBrowserSessions1792000000000();
    await migration.up(qr);
    await qr.release();

    keyIndex = { refreshSoon: jest.fn() };
    evictBrowserSession = jest.fn();
    moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === EventsGateway) return { evictBrowserSession, evictApiKey: jest.fn() };
        if (token === BrowserSessionService) return service;
        return undefined;
      }),
    } as unknown as ModuleRef;

    const usageTracker = { record: jest.fn(), flush: jest.fn(), forget: jest.fn() };
    authService = new AuthService(apiKeyRepo, usageTracker as never, moduleRef, keyIndex as unknown as ActiveKeyIndex);
    service = new BrowserSessionService(sessionRepo, authService, moduleRef, keyIndex as unknown as ActiveKeyIndex);

    activeKey = await apiKeyRepo.save(
      apiKeyRepo.create({
        name: 'Primary Admin',
        keyHash: hashApiKey('ow_primary_admin_secret_key'),
        keyPrefix: 'ow_primary_a',
        role: ApiKeyRole.ADMIN,
        isActive: true,
        allowedSessions: null,
        allowedChats: null,
        allowedIps: null,
        expiresAt: null,
      }),
    );
    // Keep a second active admin so revoking/deleting activeKey does not hit the last-admin guard.
    await apiKeyRepo.save(
      apiKeyRepo.create({
        name: 'Backup Admin',
        keyHash: hashApiKey('ow_backup_admin_secret_key'),
        keyPrefix: 'ow_backup_ad',
        role: ApiKeyRole.ADMIN,
        isActive: true,
        allowedSessions: null,
        allowedChats: null,
        allowedIps: null,
        expiresAt: null,
      }),
    );
  });

  afterEach(async () => {
    service.onModuleDestroy();
    if (ds?.isInitialized) await ds.destroy();
  });

  it('stores only a hashed session token and re-validates live ApiKey permissions on every lookup', async () => {
    const { token, session } = await service.createSession(activeKey);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(session.tokenHash).not.toBe(token);
    expect(session.apiKeyId).toBe(activeKey.id);
    expect(keyIndex.refreshSoon).toHaveBeenCalled();

    const storedRow = await ds.getRepository(BrowserSession).findOneByOrFail({ id: session.id });
    expect(JSON.stringify(storedRow)).not.toContain(token);
    expect(JSON.stringify(storedRow)).not.toContain('ow_primary_admin_secret_key');

    // Demoting and re-scoping the API key takes immediate effect on the next session validation.
    await ds
      .getRepository(ApiKey)
      .update(
        { id: activeKey.id },
        { role: ApiKeyRole.VIEWER, allowedSessions: ['sess-1'], allowedIps: ['192.0.2.10'] },
      );

    const validated = await service.validateSessionToken(token, '192.0.2.10');
    expect(validated.apiKey.role).toBe(ApiKeyRole.VIEWER);
    expect(validated.apiKey.allowedSessions).toEqual(['sess-1']);

    // An IP outside the updated allowedIps is rejected immediately.
    await expect(service.validateSessionToken(token, '203.0.113.5')).rejects.toThrow(ForbiddenException);
  });

  it('revokes browser sessions immediately when the underlying ApiKey is revoked or deleted', async () => {
    const { token } = await service.createSession(activeKey);

    await authService.revoke(activeKey.id);

    await expect(service.validateSessionToken(token, '127.0.0.1')).rejects.toThrow(UnauthorizedException);
    const row = await ds.getRepository(BrowserSession).findOneByOrFail({ apiKeyId: activeKey.id });
    expect(row.revokedAt).not.toBeNull();
  });

  it('revokes browser sessions on AuthService.delete and rejects future lookups', async () => {
    const { token, session } = await service.createSession(activeKey);

    await authService.delete(activeKey.id);

    await expect(service.validateSessionToken(token, '127.0.0.1')).rejects.toThrow(UnauthorizedException);
    await expect(service.validateSessionById(session.id, '127.0.0.1')).rejects.toThrow(UnauthorizedException);
  });

  it('revokeByToken marks revokedAt, refreshes key index, evicts WS sockets, and blocks reuse', async () => {
    const { token, session } = await service.createSession(activeKey);
    keyIndex.refreshSoon.mockClear();

    const revokedId = await service.revokeByToken(token);
    expect(revokedId).toBe(session.id);
    expect(keyIndex.refreshSoon).toHaveBeenCalled();
    expect(evictBrowserSession).toHaveBeenCalledWith(session.id, 'logged_out');
    await expect(service.validateSessionToken(token, '127.0.0.1')).rejects.toThrow(UnresolvedApiKeyException);
  });

  it('throws UnresolvedApiKeyException for expired sessions so guard audit limiting applies', async () => {
    const repo = ds.getRepository(BrowserSession);
    await repo.save(
      repo.create({
        tokenHash: hashApiKey('expired-session-tok'),
        apiKeyId: activeKey.id,
        expiresAt: new Date(Date.now() - 10_000),
        revokedAt: null,
      }),
    );
    await expect(service.validateSessionToken('expired-session-tok', '127.0.0.1')).rejects.toThrow(
      UnresolvedApiKeyException,
    );
  });

  it('enforces per-key active session cap (25) by evicting oldest sessions', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 27; i++) {
      const { token } = await service.createSession(activeKey);
      tokens.push(token);
    }

    const activeRows = await ds
      .getRepository(BrowserSession)
      .find({ where: { apiKeyId: activeKey.id } })
      .then(rows => rows.filter(r => r.revokedAt === null));
    expect(activeRows.length).toBeLessThanOrEqual(25);
    // Oldest two sessions were evicted; newest session remains valid.
    await expect(service.validateSessionToken(tokens[0], '127.0.0.1')).rejects.toThrow(UnresolvedApiKeyException);
    await expect(service.validateSessionToken(tokens[1], '127.0.0.1')).rejects.toThrow(UnresolvedApiKeyException);
    await expect(service.validateSessionToken(tokens[26], '127.0.0.1')).resolves.toMatchObject({
      apiKey: { id: activeKey.id },
    });
  });

  it('enforces global active session ceiling by pruning expired rows first and evicting oldest active rows', async () => {
    const repo = ds.getRepository(BrowserSession);
    // Lower the ceiling on this test instance so we can exercise global pruning + eviction cleanly.
    Object.defineProperty(service, 'maxSessionsGlobal', { value: 3 });

    await repo.save(
      repo.create({
        tokenHash: hashApiKey('global-expired'),
        apiKeyId: activeKey.id,
        expiresAt: new Date(Date.now() - 60_000),
        revokedAt: null,
      }),
    );

    const first = await service.createSession(activeKey);
    const second = await service.createSession(activeKey);
    const third = await service.createSession(activeKey);
    const fourth = await service.createSession(activeKey);

    expect(await repo.findOneBy({ tokenHash: hashApiKey('global-expired') })).toBeNull();
    await expect(service.validateSessionToken(first.token, '127.0.0.1')).rejects.toThrow(UnresolvedApiKeyException);
    await expect(service.validateSessionToken(second.token, '127.0.0.1')).resolves.toBeDefined();
    await expect(service.validateSessionToken(third.token, '127.0.0.1')).resolves.toBeDefined();
    await expect(service.validateSessionToken(fourth.token, '127.0.0.1')).resolves.toBeDefined();
  });

  it('prunes expired and stale revoked sessions while keeping active sessions intact', async () => {
    const repo = ds.getRepository(BrowserSession);
    const { session: active } = await service.createSession(activeKey);
    const expired = await repo.save(
      repo.create({
        tokenHash: hashApiKey('expired-tok'),
        apiKeyId: activeKey.id,
        expiresAt: new Date(Date.now() - 60_000),
        revokedAt: null,
      }),
    );
    const staleRevoked = await repo.save(
      repo.create({
        tokenHash: hashApiKey('stale-revoked-tok'),
        apiKeyId: activeKey.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      }),
    );

    const pruned = await service.pruneExpired();
    expect(pruned).toBe(2);
    expect(await repo.findOneBy({ id: active.id })).not.toBeNull();
    expect(await repo.findOneBy({ id: expired.id })).toBeNull();
    expect(await repo.findOneBy({ id: staleRevoked.id })).toBeNull();
  });

  it('uses ConfigService auth.dashboardSessionTtlMs override when provided', async () => {
    const savedTtl = process.env.DASHBOARD_SESSION_TTL_MS;
    delete process.env.DASHBOARD_SESSION_TTL_MS;
    try {
      const cfg = {
        get: jest.fn((key: string) => (key === 'auth.dashboardSessionTtlMs' ? 900_000 : undefined)),
      } as unknown as ConfigService;
      const configuredService = new BrowserSessionService(
        ds.getRepository(BrowserSession),
        authService,
        moduleRef,
        keyIndex as unknown as ActiveKeyIndex,
        cfg,
      );
      const created = await configuredService.createSession(activeKey);
      expect(created.ttlMs).toBe(900_000);
      expect(created.session.expiresAt.getTime() - created.session.createdAt.getTime()).toBe(900_000);
    } finally {
      if (savedTtl === undefined) delete process.env.DASHBOARD_SESSION_TTL_MS;
      else process.env.DASHBOARD_SESSION_TTL_MS = savedTtl;
    }
  });

  it('migration down cleanly drops browser_sessions table', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateBrowserSessions1792000000000();
    await migration.down(qr);
    await qr.release();

    const tables = await ds.query<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_sessions'`,
    );
    expect(tables).toEqual([]);
  });
});

describe('BrowserSessionController', () => {
  const createSession = jest.fn();
  const revokeByToken = jest.fn();
  const browserSessionService = { createSession, revokeByToken } as unknown as BrowserSessionService;
  const engineFactory = { getCurrentEngine: jest.fn(() => 'baileys') } as unknown as EngineFactory;
  const configService = { get: jest.fn(() => ['10.0.0.1']) } as unknown as ConfigService;

  const controller = new BrowserSessionController(browserSessionService, engineFactory, configService);

  beforeEach(() => {
    jest.clearAllMocks();
    (engineFactory.getCurrentEngine as jest.Mock).mockReturnValue('baileys');
    (configService.get as jest.Mock).mockReturnValue(['10.0.0.1']);
  });

  it('marks POST /auth/session as @HeaderAuthOnly() and DELETE /auth/session as @Public() with 403 CSRF OpenAPI response', () => {
    const createHandler = Object.getOwnPropertyDescriptor(BrowserSessionController.prototype, 'createSession')
      ?.value as object;
    const deleteHandler = Object.getOwnPropertyDescriptor(BrowserSessionController.prototype, 'deleteSession')
      ?.value as object;
    const deleteResponses = (Reflect.getMetadata('swagger/apiResponse', deleteHandler) ?? {}) as Record<
      string,
      unknown
    >;
    expect(Reflect.getMetadata(HEADER_AUTH_ONLY_KEY, createHandler)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_KEY, deleteHandler)).toBe(true);
    expect(Object.keys(deleteResponses)).toContain('403');
  });

  it('POST /auth/session mints opaque cookie with HttpOnly SameSite=Strict and never leaks secrets in body', async () => {
    createSession.mockResolvedValue({
      token: 'opaque-browser-token',
      session: { id: 'bs-1' },
      ttlMs: 3600_000,
    });
    const setHeader = jest.fn();
    const req = {
      secure: false,
      socket: { remoteAddress: '10.0.0.1' },
      headers: {
        'x-api-key': 'ow_raw_secret',
        'x-forwarded-proto': 'https',
      },
    } as unknown as Request;
    const res = { setHeader } as unknown as Response;
    const apiKey = {
      id: 'k-admin',
      role: ApiKeyRole.ADMIN,
      allowedSessions: ['s1'],
    } as ApiKey;

    const body = await controller.createSession(apiKey, req, res);

    expect(body).toEqual({
      valid: true,
      role: ApiKeyRole.ADMIN,
      engineType: 'baileys',
      scoped: true,
      apiKeyId: 'k-admin',
    });
    expect(JSON.stringify(body)).not.toContain('ow_raw_secret');
    expect(JSON.stringify(body)).not.toContain('opaque-browser-token');
    expect(setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      'openwa_session=opaque-browser-token; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600; Secure',
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('POST /auth/session revokes an existing openwa_session cookie before issuing a replacement', async () => {
    createSession.mockResolvedValue({
      token: 'replacement-token',
      session: { id: 'bs-2' },
      ttlMs: 3600_000,
    });
    const setHeader = jest.fn();
    const req = {
      secure: true,
      headers: {
        'x-api-key': 'ow_raw_secret',
        cookie: 'openwa_session=prior-cookie-token',
      },
    } as unknown as Request;
    const res = { setHeader } as unknown as Response;

    await controller.createSession({ id: 'k-admin', role: ApiKeyRole.ADMIN } as ApiKey, req, res);
    expect(revokeByToken).toHaveBeenCalledWith('prior-cookie-token');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('POST /auth/session rejects requests that lack an API key header', async () => {
    const req = { headers: { cookie: 'openwa_session=existing' } } as unknown as Request;
    const res = { setHeader: jest.fn() } as unknown as Response;
    await expect(controller.createSession({ id: 'k1', role: ApiKeyRole.ADMIN } as ApiKey, req, res)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('GET /auth/session returns live session metadata and Cache-Control: no-store', () => {
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;
    const body = controller.getSession({ id: 'k-op', role: ApiKeyRole.OPERATOR, allowedSessions: null } as ApiKey, res);
    expect(body).toEqual({
      valid: true,
      role: ApiKeyRole.OPERATOR,
      engineType: 'baileys',
      scoped: false,
      apiKeyId: 'k-op',
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('DELETE /auth/session enforces CSRF when a cookie is present, revokes on valid same-origin request, and stays idempotent without a cookie', async () => {
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;

    // Cross-site / missing CSRF header with cookie must be rejected without revoking.
    await expect(
      controller.deleteSession(
        {
          method: 'DELETE',
          secure: true,
          headers: { cookie: 'openwa_session=tok-logout', host: 'wa.example.com', origin: 'https://wa.example.com' },
        } as unknown as Request,
        res,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(revokeByToken).not.toHaveBeenCalled();

    const resultWithCookie = await controller.deleteSession(
      {
        method: 'DELETE',
        secure: true,
        headers: {
          cookie: 'openwa_session=tok-logout',
          host: 'wa.example.com',
          origin: 'https://wa.example.com',
          'sec-fetch-site': 'same-origin',
          'x-requested-with': 'OpenWA-Dashboard',
        },
      } as unknown as Request,
      res,
    );
    expect(resultWithCookie).toEqual({ ok: true });
    expect(revokeByToken).toHaveBeenCalledWith('tok-logout');
    expect(setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      'openwa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure',
    );

    revokeByToken.mockClear();
    setHeader.mockClear();
    const resultWithoutCookie = await controller.deleteSession(
      { method: 'DELETE', secure: false, headers: {} } as unknown as Request,
      res,
    );
    expect(resultWithoutCookie).toEqual({ ok: true });
    expect(revokeByToken).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      'openwa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );

    // Behind a TLS-terminating reverse proxy over plain HTTP with TRUSTED_PROXIES=[]:
    revokeByToken.mockClear();
    setHeader.mockClear();
    (configService.get as jest.Mock).mockReturnValue([]);
    const resultBehindTlsProxy = await controller.deleteSession(
      {
        method: 'DELETE',
        secure: false,
        headers: {
          cookie: 'openwa_session=tok-proxy-logout',
          host: 'wa.example.com',
          origin: 'https://wa.example.com',
          'sec-fetch-site': 'same-origin',
          'x-requested-with': 'OpenWA-Dashboard',
        },
      } as unknown as Request,
      res,
    );
    expect(resultBehindTlsProxy).toEqual({ ok: true });
    expect(revokeByToken).toHaveBeenCalledWith('tok-proxy-logout');
  });

  it('honors ConfigService auth.dashboardSessionCookieSecure override on createSession and deleteSession', async () => {
    const savedSecure = process.env.DASHBOARD_SESSION_COOKIE_SECURE;
    delete process.env.DASHBOARD_SESSION_COOKIE_SECURE;
    try {
      createSession.mockResolvedValue({
        token: 'cfg-override-token',
        session: { id: 'bs-cfg' },
        ttlMs: 3600_000,
      });

      // Force Secure=true on a plain HTTP request via ConfigService.
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'security.trustedProxies') return [];
        if (key === 'auth.dashboardSessionCookieSecure') return true;
        return undefined;
      });
      const setHeaderTrue = jest.fn();
      await controller.createSession(
        { id: 'k-admin', role: ApiKeyRole.ADMIN } as ApiKey,
        { secure: false, headers: { 'x-api-key': 'ow_raw_secret' } } as unknown as Request,
        { setHeader: setHeaderTrue } as unknown as Response,
      );
      expect(setHeaderTrue).toHaveBeenCalledWith(
        'Set-Cookie',
        'openwa_session=cfg-override-token; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600; Secure',
      );

      // Force Secure=false on an HTTPS request via ConfigService.
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'security.trustedProxies') return [];
        if (key === 'auth.dashboardSessionCookieSecure') return false;
        return undefined;
      });
      const setHeaderFalse = jest.fn();
      await controller.deleteSession(
        { method: 'DELETE', secure: true, headers: {} } as unknown as Request,
        { setHeader: setHeaderFalse } as unknown as Response,
      );
      expect(setHeaderFalse).toHaveBeenCalledWith(
        'Set-Cookie',
        'openwa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      );
    } finally {
      if (savedSecure === undefined) delete process.env.DASHBOARD_SESSION_COOKIE_SECURE;
      else process.env.DASHBOARD_SESSION_COOKIE_SECURE = savedSecure;
    }
  });
});
