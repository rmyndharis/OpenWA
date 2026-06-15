import { readFileSync } from 'fs';
import { join } from 'path';
// js-yaml has no bundled types here; require + cast (matches the repo's plugin-loader pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface ComposeFile {
  services: Record<string, { networks?: string[] }>;
  networks: Record<string, { internal?: boolean }>;
}

/**
 * Regression lock: the Docker socket proxy must live on a dedicated
 * internal network that the dashboard (and other untrusted peers) cannot reach.
 */
describe('docker-compose network segmentation', () => {
  const compose = yaml.load(readFileSync(join(__dirname, '../../../docker-compose.yml'), 'utf8')) as ComposeFile;

  it('declares an internal-only network for the docker socket proxy', () => {
    expect(compose.networks['internal-docker'].internal).toBe(true);
  });

  it('puts docker-proxy ONLY on the internal network (not the shared app network)', () => {
    expect(compose.services['docker-proxy'].networks).toEqual(['internal-docker']);
  });

  it('keeps the dashboard OFF the internal docker network (cannot reach docker-proxy:2375)', () => {
    expect(compose.services['dashboard'].networks ?? []).not.toContain('internal-docker');
  });

  it('lets openwa-api reach the proxy via the internal network', () => {
    expect(compose.services['openwa-api'].networks).toContain('internal-docker');
  });
});
