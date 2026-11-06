/**
 * WhatsApp Web build resolution for the whatsapp-web.js engine — kept free of whatsapp-web.js
 * imports (env + fetch + the app logger only) so the infra status endpoint can import it without
 * pulling in the heavy whatsapp-web.js module and breaking engine lazy-loading.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../common/services/logger.service';

const logger = createLogger('WebVersion');

type RemoteWebVersionPin = { webVersion: string; webVersionCache: { type: 'remote'; remotePath: string } };
type LocalWebVersionPin = { webVersion: string; webVersionCache: { type: 'local'; path: string; strict: true } };
export type WebVersionPin = RemoteWebVersionPin | LocalWebVersionPin;

// The wppconnect-team/wa-version registry tracks the current known-good WhatsApp Web build. Its
// `currentVersion` is what we pin to when the operator hasn't chosen one — far more reliable than
// whatsapp-web.js's own auto-select, which can latch onto a bleeding-edge build that authenticates
// then never reaches "ready" and disconnect-loops (#488).
export const WA_VERSION_REGISTRY_URL =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json';

const DEFAULT_REMOTE_TEMPLATE = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';

// Module-level cache: undefined = not yet resolved, string = the resolved current build (refreshed
// after CACHE_TTL_MS). A failed fetch is NOT cached permanently — but to avoid re-stalling every
// call (e.g. each /infra/status poll and every session start/reconnect) on a firewalled/offline
// host, a failure is rate-limited by `lastFailureAt`: subsequent calls skip the fetch for
// FAILURE_BACKOFF_MS and answer the previously resolved build (null if none), then retry.
// `inFlight` dedupes concurrent resolves into a single fetch.
const FAILURE_BACKOFF_MS = 60_000;
// Minimum age a WhatsApp Web build must reach before we'll auto-pin it. The registry's
// `currentVersion` tracks the latest build, which can be minutes old and unvalidated; a build
// published at least this long ago is far less likely to hang before reaching QR readiness on a
// fresh start (the #488 / #684 failure class). Exposed for tests.
export const WEB_VERSION_SETTLE_MS = 12 * 60 * 60 * 1000; // 12h
// How long a resolved build is reused before the registry is read again. The registry deletes a
// build's HTML about 60 days after release, so a pin held for the life of the process eventually 404s
// and the page silently loads the live build instead.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let cachedCurrentVersion: string | undefined;
let cachedAt = 0;
let inFlight: Promise<string | null> | null = null;
let lastFailureAt = 0;

let warnedRemoteTrust = false;

// The pinned build's HTML. whatsapp-web.js's own remote cache fetches it with no timeout and, being
// non-strict, loads WhatsApp's live build when the fetch fails: the #488 class the pin exists to
// prevent. A non-OK answer falls back with nothing logged, a network error reaches only a bare
// console.error, and a hang never ends. It is fetched here instead, bounded, and handed to the library
// as a strict local cache. The latest successful download is kept in memory (a build's HTML does not
// change, and a pin only moves forward, so older builds are dropped); a failure is not, so the next
// start retries.
export const PINNED_HTML_TIMEOUT_MS = 10_000;
const PINNED_HTML_MIN_LENGTH = 1024;
const PINNED_HTML_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const pinnedHtml = new Map<string, string>();
const pinnedHtmlInFlight = new Map<string, Promise<string>>();

// WhatsApp's logged-out landing page, which the registry has stored as the HTML of a few builds. It passes the
// length and <html checks, but it holds none of WhatsApp Web's modules, so a session started on it fails at once
// (`window.require('WAWebSocketModel')` is null). Its root element's id names it.
const LOGGED_OUT_PAGE = /<html\b[^>]*\bid\s*=\s*["']whatsapp-web-logged-out["']/i;
class LoggedOutPageError extends Error {}
// Builds whose page was that one. The next auto-resolve skips them, so the pin moves to an older settled build
// instead of holding the broken one for CACHE_TTL_MS.
const rejectedBuilds = new Set<string>();
// How many registry builds an auto pin tries before the session loads the live build instead.
const MAX_AUTO_BUILDS = 3;

/** Test-only: reset the resolved-version cache between cases. */
export function __resetWebVersionCache(): void {
  cachedCurrentVersion = undefined;
  cachedAt = 0;
  inFlight = null;
  lastFailureAt = 0;
  warnedRemoteTrust = false;
  pinnedHtml.clear();
  pinnedHtmlInFlight.clear();
  rejectedBuilds.clear();
}

/**
 * Warn once per process when a remote-HTML pin takes effect. The pinned HTML is fetched over the
 * network and executed inside the authenticated web.whatsapp.com origin with no integrity check,
 * so pinning is a trust decision the operator must make knowingly — the log states the source and
 * the opt-outs. Once-only: resolveWebVersionPin runs on every session (re)start.
 */
function warnRemoteTrustOnce(pin: RemoteWebVersionPin): void {
  if (warnedRemoteTrust) return;
  warnedRemoteTrust = true;
  logger.warn(
    'WhatsApp Web build pinned to remote HTML served into the web.whatsapp.com origin WITHOUT an integrity check',
    {
      action: 'web_version_remote_pin',
      webVersion: pin.webVersion,
      remotePath: splitCredentials(pin.webVersionCache.remotePath).href,
      optOut:
        'set WWEBJS_WEB_VERSION=off for the first-party build served by WhatsApp, or point WWEBJS_WEB_VERSION_REMOTE_PATH at an operator-controlled copy',
    },
  );
}

/**
 * Report a failed registry resolve. Without this the degradation is invisible: the fetch is
 * swallowed, `resolveWebVersionPin` returns undefined, and the adapter logs only inside
 * `if (versionPin)` — so a host that cannot reach the registry silently falls back to
 * whatsapp-web.js's own version selection, which is the failure class the pin exists to prevent
 * (#488), with nothing in the log to grep for.
 *
 * Deliberately NOT once-per-process like `warnRemoteTrustOnce`. The state is ongoing rather than a
 * one-time decision, and an operator diagnosing a session days into a container's life reads a
 * bounded log window (`docker compose logs --tail=…`) — a warning emitted only at first failure
 * would have scrolled away exactly when it is needed. Repetition is already bounded: the
 * `lastFailureAt` backoff returns before the fetch, so at most one attempt (hence one warning) per
 * FAILURE_BACKOFF_MS.
 */
function warnResolveFailed(reason: string, previous: string | null): void {
  if (previous) {
    logger.warn('Could not refresh the WhatsApp Web build from the wa-version registry; keeping the previous pin', {
      action: 'web_version_refresh_failed',
      reason,
      webVersion: previous,
      registry: WA_VERSION_REGISTRY_URL,
    });
    return;
  }
  logger.warn('Could not resolve a WhatsApp Web build from the wa-version registry — continuing WITHOUT a pin', {
    action: 'web_version_resolve_failed',
    reason,
    registry: WA_VERSION_REGISTRY_URL,
    consequence:
      "whatsapp-web.js selects the build itself, which on some setups authenticates then never reaches 'ready'",
    remedy:
      'confirm the host can reach the registry URL, or set WWEBJS_WEB_VERSION to an exact build (or "off" to accept the first-party build)',
  });
}

function buildRemotePin(version: string): RemoteWebVersionPin {
  const template = process.env.WWEBJS_WEB_VERSION_REMOTE_PATH?.trim() || DEFAULT_REMOTE_TEMPLATE;
  return {
    webVersion: version,
    webVersionCache: { type: 'remote', remotePath: template.replace('{version}', version) },
  };
}

type WaVersionEntry = { version?: unknown; beta?: unknown; released?: unknown; expire?: unknown };

/**
 * Pick the WhatsApp Web build to auto-pin from the registry's `versions[]`: the newest non-beta,
 * unexpired build published at least `WEB_VERSION_SETTLE_MS` ago — i.e. one the ecosystem has had
 * time to validate — rather than the registry's `currentVersion`, which can be minutes old. Falls
 * back to `currentVersion` when no build qualifies (a freshly-reset registry, or every build still
 * too new), so this hardens pinning without ever defeating it. Builds in `skip` (their page was not the app) are
 * passed over, `currentVersion` included. Pure: pass `now` explicitly.
 */
export function pickSettledWebVersion(
  versions: unknown,
  now: number,
  currentVersion: string | null,
  skip: ReadonlySet<string> = new Set(),
): string | null {
  const fallback = currentVersion && !skip.has(currentVersion) ? currentVersion : null;
  if (!Array.isArray(versions)) return fallback;
  const settledCutoff = now - WEB_VERSION_SETTLE_MS;
  let best: { version: string; released: number } | null = null;
  for (const raw of versions) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as WaVersionEntry;
    if (typeof e.version !== 'string' || !/^\d/.test(e.version) || skip.has(e.version)) continue;
    if (e.beta === true) continue;
    const released = typeof e.released === 'string' ? Date.parse(e.released) : NaN;
    if (!Number.isFinite(released) || released > settledCutoff) continue; // too fresh
    const expire = typeof e.expire === 'string' ? Date.parse(e.expire) : NaN;
    if (Number.isFinite(expire) && expire <= now) continue; // already expired
    if (!best || best.released < released) best = { version: e.version, released };
  }
  return best?.version ?? fallback;
}

/**
 * Fetch the current known-good WhatsApp Web build from the wa-version registry. A SUCCESSFUL resolve
 * is cached for CACHE_TTL_MS, then refreshed; a failure is NOT cached, so a later call retries (a
 * single transient outage must not permanently defeat the #488 fix). A failed refresh keeps the
 * previous build, and only a process that never resolved one gets null. Concurrent callers share one
 * in-flight fetch. Prefers a build that has settled (see `pickSettledWebVersion`) over the registry's
 * possibly-minute-old `currentVersion`.
 */
export async function resolveCurrentWebVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  const previous = cachedCurrentVersion ?? null;
  if (previous && Date.now() - cachedAt < CACHE_TTL_MS) return previous;
  if (inFlight) return inFlight;
  // Within the backoff window after a recent failure, answer instantly without a network call so a
  // firewalled/offline host doesn't re-stall on every status poll / session start.
  if (lastFailureAt && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return previous;
  inFlight = (async (): Promise<string | null> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetcher(WA_VERSION_REGISTRY_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { currentVersion?: unknown; versions?: unknown };
        const rawCurrent =
          typeof json.currentVersion === 'string' && /^\d/.test(json.currentVersion) ? json.currentVersion : null;
        const picked = pickSettledWebVersion(json.versions, Date.now(), rawCurrent, rejectedBuilds);
        if (picked) {
          cachedCurrentVersion = picked; // cache only on success
          cachedAt = Date.now();
          return picked;
        }
        lastFailureAt = Date.now(); // nothing usable — back off, then retry
        warnResolveFailed('the registry carried no usable build', previous);
        return previous;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastFailureAt = Date.now(); // fetch failed — back off, then retry
      warnResolveFailed(error instanceof Error ? error.message : String(error), previous);
      return previous;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Resolve the WhatsApp Web version pin for the whatsapp-web.js client.
 * - Explicit `WWEBJS_WEB_VERSION` (a version string)  → pin it exactly (no network call).
 * - `off`                                             → no pin; whatsapp-web.js native auto-select.
 * - unset / `auto` / `latest`                         → auto-resolve the current known-good build
 *   from the wa-version registry and pin it; if that fetch fails, keep the previously resolved
 *   build, or fall back to native auto-select when none was ever resolved.
 * `WWEBJS_WEB_VERSION_REMOTE_PATH` overrides the HTML URL template (`{version}` placeholder).
 * With `cacheDir`, the pinned HTML is downloaded there first and the pin becomes a strict local cache;
 * a download that fails (or takes over PINNED_HTML_TIMEOUT_MS) drops the pin with a named warning. An auto-resolved
 * build whose page is the logged-out landing page is skipped for the next older settled build (up to
 * MAX_AUTO_BUILDS tried); an exact version the operator set is never swapped.
 * The auto-resolve replaces whatsapp-web.js's unreliable default that caused #488 (scan → stuck →
 * disconnect loop) on Docker setups where no version was pinned.
 */
export function resolveWebVersionPin(fetcher?: typeof fetch): Promise<RemoteWebVersionPin | undefined>;
export function resolveWebVersionPin(
  fetcher: typeof fetch | undefined,
  cacheDir: string,
): Promise<WebVersionPin | undefined>;
export async function resolveWebVersionPin(
  fetcher: typeof fetch = fetch,
  cacheDir?: string,
): Promise<WebVersionPin | undefined> {
  const raw = process.env.WWEBJS_WEB_VERSION?.trim();
  const lc = raw?.toLowerCase();
  if (raw && lc !== 'off' && lc !== 'latest' && lc !== 'auto') {
    const pin = buildRemotePin(raw); // operator-pinned exact version: never swapped for another build
    warnRemoteTrustOnce(pin);
    return cacheDir ? localisePin(pin, cacheDir, fetcher, false) : pin;
  }
  if (lc === 'off') return undefined; // explicit escape hatch → native auto-select
  for (let attempt = 1; ; attempt++) {
    const current = await resolveCurrentWebVersion(fetcher);
    if (!current) return undefined;
    const pin = buildRemotePin(current);
    warnRemoteTrustOnce(pin);
    if (!cacheDir) return pin;
    const local = await localisePin(pin, cacheDir, fetcher, attempt < MAX_AUTO_BUILDS);
    // A build whose page was the logged-out one is skipped by the next resolve, which names an older build.
    if (local || !rejectedBuilds.has(current) || attempt >= MAX_AUTO_BUILDS) return local;
  }
}

/**
 * Download the pinned HTML (bounded) into `<cacheDir>/<version>.html` and answer a strict local cache
 * for it. When it cannot be had, say so by name and answer no pin: the session then loads the live
 * build, as the docs promise, instead of hanging on an unbounded fetch that ends the same way.
 */
async function localisePin(
  pin: RemoteWebVersionPin,
  cacheDir: string,
  fetcher: typeof fetch,
  willRetry: boolean,
): Promise<WebVersionPin | undefined> {
  const { webVersion } = pin;
  const { remotePath } = pin.webVersionCache;
  try {
    // The version becomes a file name, and an operator sets it: no separators, no leading dots.
    if (!/^\d[\w.-]*$/.test(webVersion)) throw new Error('the version is not a WhatsApp Web build number');
    const html = await fetchPinnedHtml(remotePath, fetcher);
    writePinnedHtml(cacheDir, webVersion, html);
    return { webVersion, webVersionCache: { type: 'local', path: cacheDir, strict: true } };
  } catch (error) {
    if (error instanceof LoggedOutPageError) {
      const first = !rejectedBuilds.has(webVersion);
      rejectedBuilds.add(webVersion);
      if (cachedCurrentVersion === webVersion) {
        cachedCurrentVersion = undefined; // the next resolve reads the registry again and skips this build
        cachedAt = 0;
      }
      if (willRetry) {
        if (first) {
          logger.warn(
            'The registry build is the WhatsApp Web logged-out page, not the app; trying an older settled build',
            {
              action: 'web_version_html_rejected',
              webVersion,
              remotePath: splitCredentials(remotePath).href,
            },
          );
        }
        return undefined;
      }
    }
    logger.warn('Could not load the pinned WhatsApp Web build; continuing WITHOUT a pin', {
      action: 'web_version_html_unavailable',
      reason: error instanceof Error ? error.message : String(error),
      webVersion,
      remotePath: splitCredentials(remotePath).href,
      consequence:
        "the live WhatsApp Web build loads instead, which on some setups authenticates then never reaches 'ready'",
      remedy:
        'confirm the host can reach remotePath, pin a build the registry still serves in WWEBJS_WEB_VERSION, or point WWEBJS_WEB_VERSION_REMOTE_PATH at a reachable copy',
    });
    return undefined;
  }
}

function fetchPinnedHtml(remotePath: string, fetcher: typeof fetch): Promise<string> {
  const cached = pinnedHtml.get(remotePath);
  if (cached) return Promise.resolve(cached);
  let pending = pinnedHtmlInFlight.get(remotePath);
  if (!pending) {
    pending = downloadPinnedHtml(remotePath, fetcher).finally(() => pinnedHtmlInFlight.delete(remotePath));
    pinnedHtmlInFlight.set(remotePath, pending);
  }
  return pending;
}

async function downloadPinnedHtml(remotePath: string, fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PINNED_HTML_TIMEOUT_MS);
  try {
    const { href, authorization } = splitCredentials(remotePath);
    const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
    const res = await fetcher(href, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (html.length < PINNED_HTML_MIN_LENGTH || !/<html/i.test(html)) {
      throw new Error('the response is not a WhatsApp Web page');
    }
    if (LOGGED_OUT_PAGE.test(html))
      throw new LoggedOutPageError('the response is the WhatsApp Web logged-out page, not the app');
    pinnedHtml.clear();
    pinnedHtml.set(remotePath, html);
    return html;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`no answer within ${PINNED_HTML_TIMEOUT_MS} ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Move URL userinfo into a Basic Authorization header. Node's fetch refuses a URL that carries
 * credentials, while the library's own fetcher used to send them this way, so a mirror reached as
 * https://user:pass@host/... keeps working. The credential-free URL is also what gets logged.
 */
function splitCredentials(remotePath: string): { href: string; authorization?: string } {
  let url: URL;
  try {
    url = new URL(remotePath);
  } catch {
    return { href: remotePath };
  }
  if (!url.username && !url.password) return { href: remotePath };
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const authorization = `Basic ${Buffer.from(`${decode(url.username)}:${decode(url.password)}`).toString('base64')}`;
  url.username = '';
  url.password = '';
  return { href: url.href, authorization };
}

/**
 * Write through a unique temp file and rename it into place: several sessions, or several nodes on
 * one data volume, can write the same build at once, and the strict cache must never read half a file.
 */
function writePinnedHtml(cacheDir: string, version: string, html: string): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${version}.html`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  // The directory sits on the backed-up data volume, and every build pinned over the months would
  // otherwise stay there. Each start rewrites its own file, so a build any session still starts on
  // is never a week old: only those that are not get removed.
  for (const name of fs.readdirSync(cacheDir)) {
    const other = path.join(cacheDir, name);
    if (other === file) continue;
    try {
      if (Date.now() - fs.statSync(other).mtimeMs > PINNED_HTML_KEEP_MS) fs.rmSync(other, { force: true });
    } catch {
      // Another writer renamed or removed it first; nothing left to prune.
    }
  }
}

/**
 * The WhatsApp Web build the gateway resolves for sessions to pin, for the dashboard to display (#488).
 * This is what is resolved, not what any one start did and not a read-back: a session whose pinned HTML
 * cannot be loaded starts without a pin and logs `web_version_html_unavailable` (see localisePin), and a
 * page can still run another build, which each session logs at READY (./adapters/wwebjs-running-build).
 * It is distinct from the whatsapp-web.js library version.
 * `source`: `pinned` = operator-set exact version; `auto` = resolved from the wa-version registry;
 * `native` = whatsapp-web.js auto-select.
 */
export function getEffectiveWebVersionInfo(): { version: string | null; source: 'pinned' | 'auto' | 'native' } {
  const raw = process.env.WWEBJS_WEB_VERSION?.trim();
  const lc = raw?.toLowerCase();
  if (raw && lc !== 'off' && lc !== 'latest' && lc !== 'auto') return { version: raw, source: 'pinned' };
  if (lc === 'off') return { version: null, source: 'native' };
  return { version: cachedCurrentVersion ?? null, source: 'auto' };
}
