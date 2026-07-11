/**
 * WhatsApp Web build resolution for the whatsapp-web.js engine — kept dependency-free (process.env +
 * fetch only) so the infra status endpoint can import it without pulling in the heavy whatsapp-web.js
 * module and breaking engine lazy-loading.
 */

export type WebVersionPin = { webVersion: string; webVersionCache: { type: 'remote'; remotePath: string } };

// The wppconnect-team/wa-version registry tracks the current known-good WhatsApp Web build. Its
// `currentVersion` is what we pin to when the operator hasn't chosen one — far more reliable than
// whatsapp-web.js's own auto-select, which can latch onto a bleeding-edge build that authenticates
// then never reaches "ready" and disconnect-loops (#488).
export const WA_VERSION_REGISTRY_URL =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json';

const DEFAULT_REMOTE_TEMPLATE = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';

// Module-level cache: undefined = not yet resolved, string = the resolved current build. A failed
// fetch is NOT cached permanently — but to avoid re-stalling every call (e.g. each /infra/status poll
// and every session start/reconnect) on a firewalled/offline host, a failure is rate-limited by
// `lastFailureAt`: subsequent calls return null instantly for FAILURE_BACKOFF_MS, then retry. `inFlight`
// dedupes concurrent resolves into a single fetch.
const FAILURE_BACKOFF_MS = 60_000;
// Minimum age a WhatsApp Web build must reach before we'll auto-pin it. The registry's
// `currentVersion` tracks the latest build, which can be minutes old and unvalidated; a build
// published at least this long ago is far less likely to hang before reaching QR readiness on a
// fresh start (the #488 / #684 failure class). Exposed for tests.
export const WEB_VERSION_SETTLE_MS = 12 * 60 * 60 * 1000; // 12h
let cachedCurrentVersion: string | undefined;
let inFlight: Promise<string | null> | null = null;
let lastFailureAt = 0;

/** Test-only: reset the resolved-version cache between cases. */
export function __resetWebVersionCache(): void {
  cachedCurrentVersion = undefined;
  inFlight = null;
  lastFailureAt = 0;
}

function buildRemotePin(version: string): WebVersionPin {
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
 * too new), so this hardens pinning without ever defeating it. Pure: pass `now` explicitly.
 */
export function pickSettledWebVersion(versions: unknown, now: number, currentVersion: string | null): string | null {
  if (!Array.isArray(versions)) return currentVersion;
  const settledCutoff = now - WEB_VERSION_SETTLE_MS;
  let best: { version: string; released: number } | null = null;
  for (const raw of versions) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as WaVersionEntry;
    if (typeof e.version !== 'string' || !/^\d/.test(e.version)) continue;
    if (e.beta === true) continue;
    const released = typeof e.released === 'string' ? Date.parse(e.released) : NaN;
    if (!Number.isFinite(released) || released > settledCutoff) continue; // too fresh
    const expire = typeof e.expire === 'string' ? Date.parse(e.expire) : NaN;
    if (Number.isFinite(expire) && expire <= now) continue; // already expired
    if (!best || best.released < released) best = { version: e.version, released };
  }
  return best?.version ?? currentVersion;
}

/**
 * Fetch the current known-good WhatsApp Web build from the wa-version registry. A SUCCESSFUL resolve
 * is cached for the process lifetime; a failure resolves to null WITHOUT caching, so a later call
 * retries (a single transient outage must not permanently defeat the #488 fix). Concurrent callers
 * share one in-flight fetch. Prefers a build that has settled (see `pickSettledWebVersion`) over the
 * registry's possibly-minute-old `currentVersion`.
 */
export async function resolveCurrentWebVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  if (typeof cachedCurrentVersion === 'string') return cachedCurrentVersion;
  if (inFlight) return inFlight;
  // Within the backoff window after a recent failure, return null instantly without a network call so
  // a firewalled/offline host doesn't re-stall on every status poll / session start.
  if (lastFailureAt && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return null;
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
        const picked = pickSettledWebVersion(json.versions, Date.now(), rawCurrent);
        if (picked) {
          cachedCurrentVersion = picked; // cache only on success
          return picked;
        }
        lastFailureAt = Date.now(); // nothing usable — back off, then retry
        return null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      lastFailureAt = Date.now(); // fetch failed — back off, then retry
      return null;
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
 *   from the wa-version registry and pin it; if that fetch fails, fall back to native auto-select.
 * `WWEBJS_WEB_VERSION_REMOTE_PATH` overrides the HTML URL template (`{version}` placeholder).
 * The auto-resolve replaces whatsapp-web.js's unreliable default that caused #488 (scan → stuck →
 * disconnect loop) on Docker setups where no version was pinned.
 */
export async function resolveWebVersionPin(fetcher: typeof fetch = fetch): Promise<WebVersionPin | undefined> {
  const raw = process.env.WWEBJS_WEB_VERSION?.trim();
  const lc = raw?.toLowerCase();
  if (raw && lc !== 'off' && lc !== 'latest' && lc !== 'auto') {
    return buildRemotePin(raw); // operator-pinned exact version
  }
  if (lc === 'off') return undefined; // explicit escape hatch → native auto-select
  const current = await resolveCurrentWebVersion(fetcher);
  return current ? buildRemotePin(current) : undefined;
}

/**
 * The WhatsApp Web build the engine is effectively using, for the dashboard to display (#488). This
 * is distinct from the whatsapp-web.js library version. `source`: `pinned` = operator-set exact
 * version; `auto` = resolved from the wa-version registry; `native` = whatsapp-web.js auto-select.
 */
export function getEffectiveWebVersionInfo(): { version: string | null; source: 'pinned' | 'auto' | 'native' } {
  const raw = process.env.WWEBJS_WEB_VERSION?.trim();
  const lc = raw?.toLowerCase();
  if (raw && lc !== 'off' && lc !== 'latest' && lc !== 'auto') return { version: raw, source: 'pinned' };
  if (lc === 'off') return { version: null, source: 'native' };
  return { version: cachedCurrentVersion ?? null, source: 'auto' };
}
