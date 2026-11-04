/**
 * The env key and value that point the app at each managed profile's bundled container. Looked up by the profile names
 * a restart request carries, so it has no prototype: a name such as `constructor` finds nothing, like any other.
 */
export const BUNDLED_SERVICE_ENV: Record<string, [string, string]> = Object.assign(
  Object.create(null) as Record<string, [string, string]>,
  {
    postgres: ['DATABASE_HOST', 'postgres'],
    redis: ['REDIS_HOST', 'redis'],
    minio: ['S3_ENDPOINT', 'http://minio:9000'],
  },
);

/**
 * Whether a host (for minio, the host of an S3 endpoint) reaches the profile's bundled container: its network alias
 * (the profile name) or its container name, in any letter case and with or without the trailing dot of an absolute
 * DNS name. The one rule for every decision that asks it; the dashboard's copy (dashboard/src/utils/bundledHost.ts) is
 * held to the same answers by its test. Imports nothing, so that test can load this file.
 */
export function namesBundledContainer(profile: string, value: string | undefined): boolean {
  if (!BUNDLED_SERVICE_ENV[profile] || value === undefined) return false;
  let host = value.trim();
  if (profile === 'minio') {
    try {
      host = new URL(host).hostname;
    } catch {
      return false;
    }
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host === profile || host === `openwa-${profile}`;
}
