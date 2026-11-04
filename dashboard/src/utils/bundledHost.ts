// The container each managed profile runs, as the restart dialog names it. No prototype, as the server's table: a
// name such as `constructor` finds nothing.
export const CONTAINER_OF: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  postgres: 'openwa-postgres',
  redis: 'openwa-redis',
  minio: 'openwa-minio',
});

/**
 * Whether a host (for minio, the host of an S3 endpoint) reaches the profile's bundled container: its network alias
 * (the profile name) or its container name, in any letter case, with or without a trailing dot. The server's
 * namesBundledContainer (src/modules/docker/bundled-host.ts) decides what the boot starts, what a restart stops and
 * which credentials a save keeps; bundledHost.test.ts holds this copy to its answers.
 */
export function namesBundledContainer(profile: string, value: string | undefined): boolean {
  if (!CONTAINER_OF[profile] || value === undefined) return false;
  let host = value.trim();
  if (profile === 'minio') {
    try {
      host = new URL(host).hostname;
    } catch {
      return false;
    }
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host === profile || host === CONTAINER_OF[profile];
}

/** Whether two hosts lead to the same server: the same value, or both the profile's bundled container. */
export const sameHost = (profile: string, a: string | undefined, b: string | undefined): boolean =>
  a === b || (namesBundledContainer(profile, a) && namesBundledContainer(profile, b));
