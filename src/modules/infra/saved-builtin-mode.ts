import { isEnvPinned } from '../../config/env-precedence';
import { namesBundledContainer } from '../docker';

/**
 * The built-in (bundled container) mode the saved configuration states for each datastore, shared by
 * GET /infra/config and the Docker-unreachable fallback of GET /infra/status so the two cannot disagree.
 *
 * `flag` is what the dashboard saves, `host` is what the next boot connects to, `profile` names the bundled container
 * that host may reach, and `selection` is the file's own record that the service is in use at all.
 */
const SERVICES = {
  database: {
    flag: 'POSTGRES_BUILTIN',
    host: 'DATABASE_HOST',
    profile: 'postgres',
    selection: 'DATABASE_TYPE',
    selected: 'postgres',
  },
  redis: {
    flag: 'REDIS_BUILTIN',
    host: 'REDIS_HOST',
    profile: 'redis',
    selection: 'REDIS_ENABLED',
    selected: 'true',
  },
  storage: {
    flag: 'MINIO_BUILTIN',
    host: 'S3_ENDPOINT',
    profile: 'minio',
    selection: 'STORAGE_TYPE',
    selected: 's3',
  },
} as const;

export type BuiltInService = keyof typeof SERVICES;

export interface SavedBuiltInMode {
  /** The mode the saved configuration implies: bundled container or not. */
  builtIn: boolean;
  /**
   * Whether that mode is a saved choice. False when a host pin decides it, when the file does not select the
   * service (the first boot writes every flag false next to a service that is not in use), and when nothing
   * says anything at all: a reader then follows what runs.
   */
  builtInSet: boolean;
}

/** The flag value the next boot reads: the environment's when it pins the flag, else the file's. */
function flagValue(service: BuiltInService, saved: Record<string, string>): string | undefined {
  const flag = SERVICES[service].flag;
  return isEnvPinned(flag) ? process.env[flag] : saved[flag];
}

/**
 * The built-in flag the environment pins, else the saved one: this instance's own record that it chose the bundled
 * container. GET /infra/status falls back to it with Docker unreachable, where a host called postgres alone is as
 * likely an external server (a Kubernetes Service, say) and must not read as the bundled container; the flag alone
 * does not either, since the process dials its host.
 */
export function effectiveBuiltInFlag(service: BuiltInService, saved: Record<string, string>): boolean {
  return flagValue(service, saved) === 'true';
}

/**
 * The next boot's host decides whether the service is built-in. A true flag starts the bundled container only
 * while its datastore is in use and the environment does not pin the host to another server.
 * Rules, in order:
 *  1. A host pinned by the environment (or the project .env) decides, as it does at boot and in
 *     requestRestart: the bundled host in any spelling that reaches the container is built-in, any other is
 *     not, and no saved flag can be a pending switch because the pin outranks it.
 *  2. Otherwise the file's host decides, and the flag counts as saved when the environment pins it, or when the file
 *     stores it for a service the file also selects. A flag that is not true beside the bundled host name in the file
 *     is no choice of an external service, though: the next boot dials the container, so it reads as built-in and
 *     nothing is saved.
 *  3. Otherwise there is nothing saved.
 */
export function savedBuiltInMode(service: BuiltInService, saved: Record<string, string>): SavedBuiltInMode {
  const spec = SERVICES[service];
  if (isEnvPinned(spec.host)) {
    return { builtIn: namesBundledContainer(spec.profile, process.env[spec.host]), builtInSet: false };
  }
  const flagPinned = isEnvPinned(spec.flag);
  const flag = flagValue(service, saved);
  const selectedInFile = saved[spec.selection] === spec.selected;
  const dialsBundled = namesBundledContainer(spec.profile, saved[spec.host]);
  if (flag !== 'true' && dialsBundled) return { builtIn: true, builtInSet: false };
  return { builtIn: dialsBundled, builtInSet: flag !== undefined && (flagPinned || selectedInFile) };
}
