import { fetchSafeBuffer } from '../plugins/plugin-download';
import { compareSemver } from '../plugins/catalog';
import { redactSsrfError } from '../../common/security/ssrf-guard';
import { createLogger } from '../../common/services/logger.service';

const logger = createLogger('UpdateCheck');

// Same source as /api/health: the version that ships with the running code, not a build-time stamp.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: APP_VERSION } = require('../../../package.json') as { version: string };

/**
 * Whether a newer OpenWA release than the running one exists, for the dashboard's update notice.
 *
 * Read-only by design: it names a release and links its notes, and upgrading stays the documented
 * procedure. It runs on the server because the dashboard's CSP only allows its own origin. The request
 * goes out directly through the SSRF guard's pinned connection, not through HTTP(S)_PROXY, and a
 * failure is only logged at debug level: an instance that never reaches GitHub reports no release, and
 * one that reached it before keeps the last answer.
 */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

// GitHub's `/releases/latest` skips drafts and prereleases, so only a published release is offered.
const LATEST_RELEASE_URL = 'https://api.github.com/repos/rmyndharis/OpenWA/releases/latest';
const RELEASE_PAGE_URL = 'https://github.com/rmyndharis/OpenWA/releases/tag/';
// One unauthenticated request per process per window stays far inside GitHub's 60 per hour per IP,
// while a long-running instance still notices a new release the same day.
const SUCCESS_TTL_MS = 6 * 60 * 60_000;
const FAILURE_BACKOFF_MS = 15 * 60_000;
// The response carries the release notes, which run to tens of KB.
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
// A plain release tag only. The `v` is stripped before comparing: compareSemver reads `v1` as 0.
const RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/;

let latest: { version: string; url: string } | null = null;
let nextCheckAt = 0;
let inFlight: Promise<void> | null = null;

/** Test-only: forget the cached release between cases. */
export function __resetUpdateCheckCache(): void {
  latest = null;
  nextCheckAt = 0;
  inFlight = null;
}

async function refresh(): Promise<void> {
  try {
    const body = JSON.parse(
      (await fetchSafeBuffer(LATEST_RELEASE_URL, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS })).toString('utf8'),
    ) as { tag_name?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
    const match = RELEASE_TAG.exec(tag);
    // The link is built from the validated tag rather than taken from the response.
    latest = match ? { version: match[1], url: `${RELEASE_PAGE_URL}${tag}` } : null;
    nextCheckAt = Date.now() + SUCCESS_TTL_MS;
  } catch (error) {
    // Offline, blocked by egress policy, rate-limited or malformed: keep whatever was known and retry
    // later. Logged once per backoff window, redacted like any other guarded fetch.
    logger.debug('Release check failed', { error: redactSsrfError(error) });
    nextCheckAt = Date.now() + FAILURE_BACKOFF_MS;
  }
}

/**
 * Whether `latest` (a plain X.Y.Z) is newer than the running version. A running prerelease counts as
 * older than its own final release: compareSemver ignores the `-rc.1` suffix, so without this an
 * instance on 0.24.0-rc.1 would never hear that 0.24.0 is out.
 */
export function isNewerRelease(latest: string, current: string): boolean {
  const cmp = compareSemver(latest, current);
  return cmp > 0 || (cmp === 0 && current.includes('-'));
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (process.env.UPDATE_CHECK_ENABLED === 'false') {
    return { current: APP_VERSION, latest: null, updateAvailable: false, releaseUrl: null };
  }
  if (Date.now() >= nextCheckAt) {
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
  return {
    current: APP_VERSION,
    latest: latest?.version ?? null,
    updateAvailable: latest !== null && isNewerRelease(latest.version, APP_VERSION),
    releaseUrl: latest?.url ?? null,
  };
}
