import * as fs from 'fs';
import * as path from 'path';

/** Storage root used when STORAGE_LOCAL_PATH is unset. Mirrors configuration.ts's `storage.localPath`. */
export const DEFAULT_STORAGE_ROOT = './data/media';

/**
 * Storage roots no operator ever chose: `GET /infra/status` read a config key that never existed
 * (`storage.path`) and returned this fallback on every request in v0.2.0–v0.7.3, so any dashboard
 * Infrastructure save in that window persisted it to `data/.env.generated` — which lives on the data
 * volume and survives every upgrade (#472 fixed the endpoint, nothing migrated the stored value).
 *
 * Both spellings are listed because `path.join` normalises `./uploads` to `uploads`, so the value can
 * be observed either way depending on which layer wrote it.
 */
const FOSSIL_STORAGE_ROOTS = new Set(['./uploads', 'uploads']);

/** Minimal logger surface (satisfied by createLogger()'s result). */
export interface StorageRootLogger {
  warn: (message: string) => void;
}

export interface StorageRootOptions {
  /** Raw STORAGE_LOCAL_PATH. Blank/undefined falls back to {@link DEFAULT_STORAGE_ROOT}. */
  configured?: string;
  /** Injectable for tests; defaults to the real filesystem probe. */
  isWritable?: (root: string) => boolean;
  logger?: StorageRootLogger;
}

/**
 * Whether the storage root can actually be written to, creating it when missing.
 *
 * This deliberately probes WRITABILITY, not existence. StorageService's own boot check is
 * `if (!existsSync(root)) mkdirSync(root)` — which is a silent no-op for a root that exists but is
 * owned by another user, so the failure only surfaces later, on the first media write (#1065).
 */
export function isStorageRootWritable(root: string): boolean {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective storage root, failing fast when it is unusable.
 *
 * A writable root is returned untouched — including a writable `./uploads`, so a bare-metal install
 * that has been happily using it is never relocated out from under its existing media. Only an
 * unwritable fossil is migrated onto the default, which is the case that cannot be anything but
 * broken: in the official image `/app` is root-owned (v0.13.0 narrowed the build's chown from `/app`
 * to `./data`), so `./uploads` resolves outside the mounted data volume and cannot be created.
 *
 * Any other unwritable root throws — a misconfiguration the operator must see and fix, not something
 * to paper over with a silent fallback. That is how this class of bug stayed invisible for so long:
 * before v0.13.0 the same fossil silently succeeded into the container's ephemeral layer, and every
 * status/chat media file written there was discarded on the next container recreate.
 */
export function resolveStorageRoot(options: StorageRootOptions): string {
  const isWritable = options.isWritable ?? isStorageRootWritable;
  const configured = options.configured?.trim() || DEFAULT_STORAGE_ROOT;

  if (isWritable(configured)) return configured;

  if (FOSSIL_STORAGE_ROOTS.has(configured) && isWritable(DEFAULT_STORAGE_ROOT)) {
    options.logger?.warn(
      `STORAGE_LOCAL_PATH='${configured}' is not writable and is a known-bad value written by a bug in ` +
        `OpenWA v0.2.0–v0.7.3 (#472); falling back to '${DEFAULT_STORAGE_ROOT}'. Remove the STORAGE_LOCAL_PATH ` +
        `line from data/.env.generated to silence this warning. Any media previously written to ` +
        `'${configured}' was outside the data volume and is not recoverable.`,
    );
    return DEFAULT_STORAGE_ROOT;
  }

  throw new Error(
    `Refusing to start: the media storage root is not writable.\n` +
      `  STORAGE_LOCAL_PATH = ${configured}\n` +
      `  resolved to        = ${path.resolve(configured)}\n` +
      `  running as uid     = ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}\n` +
      `Point STORAGE_LOCAL_PATH at a directory the app can write to (in Docker, keep it inside the ` +
      `mounted data volume — e.g. ${DEFAULT_STORAGE_ROOT}).`,
  );
}
