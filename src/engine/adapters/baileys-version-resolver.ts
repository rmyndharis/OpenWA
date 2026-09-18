import * as fs from 'fs';
import * as path from 'path';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { LoggerService } from '../../common/services/logger.service';

export type WAVersion = [number, number, number];

/**
 * Default modern fallback version when all remote endpoints and local caches are unavailable.
 * WhatsApp Web protocol versions follow semantic versioning [major, minor, client_revision].
 * Refresh during major version bumps or when WhatsApp deprecates older client revisions.
 */
export const DEFAULT_FALLBACK_WA_VERSION: WAVersion = [2, 3000, 1045340097];

/** Default timeout for remote version resolution network calls (5 seconds) */
export const VERSION_RESOLVER_TIMEOUT_MS = 5000;

export interface BaileysVersionResolverOptions {
  authDir: string;
  sessionId: string;
  logger: Pick<LoggerService, 'log' | 'warn'>;
  timeoutMs?: number;
}

export interface ResolveOptions {
  /** Global-fetch dispatcher for the session proxy; undefined on an unproxied session (direct). */
  dispatcher?: unknown;
}

/**
 * Resilient WhatsApp Web protocol version resolver.
 *
 * Implements multi-tier resolution:
 * 1. BAILEYS_WA_VERSION operator environment override
 * 2. Direct WhatsApp Web service worker endpoint (fetchLatestWaWebVersion -> web.whatsapp.com/sw.js)
 * 3. Upstream repository Defaults/index.ts (fetchLatestBaileysVersion -> GitHub raw)
 * 4. Local disk cache (last_known_wa_version.json in authDir)
 * 5. Safe modern fallback version (DEFAULT_FALLBACK_WA_VERSION)
 */
export class BaileysVersionResolver {
  private readonly cacheFilePath: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: BaileysVersionResolverOptions) {
    this.cacheFilePath = path.join(this.options.authDir, 'last_known_wa_version.json');
    this.timeoutMs = options.timeoutMs ?? VERSION_RESOLVER_TIMEOUT_MS;
  }

  async resolve(b: typeof BaileysLib, resolveOptions: ResolveOptions = {}): Promise<WAVersion> {
    const envVersion = this.resolveFromEnv();
    if (envVersion) {
      return envVersion;
    }

    const waWebVersion = await this.resolveFromWaWeb(b, resolveOptions);
    if (waWebVersion) {
      return waWebVersion;
    }

    const baileysVersion = await this.resolveFromBaileys(b, resolveOptions);
    if (baileysVersion) {
      return baileysVersion;
    }

    const cachedVersion = this.resolveFromDiskCache();
    if (cachedVersion) {
      return cachedVersion;
    }

    this.options.logger.warn(
      `All remote version endpoints and disk cache unavailable; using fallback WhatsApp Web version: ${DEFAULT_FALLBACK_WA_VERSION.join('.')}`,
      { sessionId: this.options.sessionId },
    );
    return DEFAULT_FALLBACK_WA_VERSION;
  }

  private resolveFromEnv(): WAVersion | null {
    const raw = process.env.BAILEYS_WA_VERSION?.trim();
    if (!raw) {
      return null;
    }

    const match = raw.match(/^(\d+)[.,](\d+)[.,](\d+)$/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      const patch = parseInt(match[3], 10);

      if (major === 2 && minor >= 2000 && patch >= 0) {
        const version: WAVersion = [major, minor, patch];
        this.options.logger.log(`Using BAILEYS_WA_VERSION override: ${version.join('.')}`, {
          sessionId: this.options.sessionId,
        });
        return version;
      }
    }

    this.options.logger.warn(
      `Invalid BAILEYS_WA_VERSION "${raw}", expected format "2.3000.xxxxxxxxx" (e.g. "2.3000.1045340097")`,
      { sessionId: this.options.sessionId },
    );
    return null;
  }

  private async resolveFromWaWeb(b: typeof BaileysLib, resolveOptions: ResolveOptions): Promise<WAVersion | null> {
    if (typeof b.fetchLatestWaWebVersion !== 'function') {
      return null;
    }

    try {
      const fetchOptions = {
        ...(resolveOptions.dispatcher ? { dispatcher: resolveOptions.dispatcher } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      } as unknown as RequestInit;

      const result = await b.fetchLatestWaWebVersion(fetchOptions);

      if (result?.isLatest === true && this.isValidVersion(result?.version)) {
        const version = result.version;
        this.saveCachedVersion(version);
        return version;
      }

      this.options.logger.warn(
        `fetchLatestWaWebVersion returned isLatest=false (${JSON.stringify(result?.version)}); advancing to next tier`,
        { sessionId: this.options.sessionId },
      );
    } catch (err) {
      this.options.logger.warn(`fetchLatestWaWebVersion failed: ${err instanceof Error ? err.message : String(err)}`, {
        sessionId: this.options.sessionId,
      });
    }

    return null;
  }

  private async resolveFromBaileys(b: typeof BaileysLib, resolveOptions: ResolveOptions): Promise<WAVersion | null> {
    if (typeof b.fetchLatestBaileysVersion !== 'function') {
      return null;
    }

    try {
      // Baileys' fetchLatestBaileysVersion does not forward signal, so race it with a timeout
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('fetchLatestBaileysVersion timeout')), this.timeoutMs);
        // Same shape as withQueryDeadline: an un-unref'd timer would hold the loop open for the
        // rest of its window if the process tried to exit mid-resolve.
        timeoutId.unref?.();
      });

      const fetchOptions = (resolveOptions.dispatcher
        ? { dispatcher: resolveOptions.dispatcher }
        : undefined) as unknown as RequestInit;

      const fetchPromise = b.fetchLatestBaileysVersion(fetchOptions);
      // Racing abandons the loser without cancelling it. Today that call cannot reject (it catches
      // everything and resolves the frozen stub), so this is defence against the library changing,
      // not a live bug: an abandoned rejection would otherwise surface as an unhandled rejection.
      fetchPromise.catch(() => undefined);

      const result = await Promise.race([fetchPromise, timeoutPromise]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      if (result?.isLatest === true && this.isValidVersion(result?.version)) {
        const version = result.version;
        this.saveCachedVersion(version);
        return version;
      }

      this.options.logger.warn(
        `fetchLatestBaileysVersion returned isLatest=false (${JSON.stringify(result?.version)}); advancing to next tier`,
        { sessionId: this.options.sessionId },
      );
    } catch (err) {
      this.options.logger.warn(
        `fetchLatestBaileysVersion failed: ${err instanceof Error ? err.message : String(err)}`,
        { sessionId: this.options.sessionId },
      );
    }

    return null;
  }

  private resolveFromDiskCache(): WAVersion | null {
    try {
      if (!fs.existsSync(this.cacheFilePath)) {
        return null;
      }

      const content = fs.readFileSync(this.cacheFilePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (this.isValidVersion(parsed)) {
        this.options.logger.warn(`Using cached WhatsApp Web version from disk: ${parsed.join('.')}`, {
          sessionId: this.options.sessionId,
        });
        return parsed;
      }
    } catch {
      // Non-blocking disk read fallback
    }

    return null;
  }

  private saveCachedVersion(version: WAVersion): void {
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(version), 'utf8');
    } catch {
      // Non-blocking best-effort caching
    }
  }

  private isValidVersion(v: unknown): v is WAVersion {
    return (
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    );
  }
}
