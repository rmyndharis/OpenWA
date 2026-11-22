import { readFileSync } from 'fs';
import { join } from 'path';
// js-yaml has no bundled types here; require + cast (matches the repo's plugin-loader pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface ComposeService {
  networks?: string[];
  volumes?: string[];
  profiles?: string[];
  security_opt?: string[];
  cap_drop?: string[];
  read_only?: boolean;
  tmpfs?: string[];
  mem_limit?: string;
  pids_limit?: number;
  environment?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean }>;
}

/**
 * Regression lock: the Docker socket proxy must be opt-in, hardened, and isolated on a dedicated
 * internal network that untrusted peers cannot reach.
 */
describe('docker-compose network segmentation', () => {
  const compose = yaml.load(readFileSync(join(__dirname, '../../../docker-compose.yml'), 'utf8')) as ComposeFile;

  it('declares an internal-only network for the docker socket proxy', () => {
    expect(compose.networks['internal-docker'].internal).toBe(true);
  });

  it('puts docker-proxy ONLY on the internal network (not the shared app network)', () => {
    expect(compose.services['docker-proxy'].networks).toEqual(['internal-docker']);
  });

  it('gates docker-proxy behind the opt-in docker-proxy profile and hardens the sidecar', () => {
    const proxy = compose.services['docker-proxy'];
    expect(proxy.profiles).toEqual(['docker-proxy']);
    expect(proxy.security_opt).toContain('no-new-privileges:true');
    expect(proxy.cap_drop).toEqual(['ALL']);
    expect(proxy.read_only).toBe(true);
    expect(proxy.tmpfs).toEqual(expect.arrayContaining(['/tmp', '/run']));
    expect(proxy.mem_limit).toBe('128m');
    expect(proxy.pids_limit).toBe(64);
  });

  it('lets openwa-api reach the proxy via the internal network without hardcoding DOCKER_HOST', () => {
    expect(compose.services['openwa-api'].networks).toContain('internal-docker');
    const env = compose.services['openwa-api'].environment ?? [];
    expect(env).toContain('DOCKER_HOST=${DOCKER_HOST:-}');
    expect(env).toContain('DOCKER_ALLOW_LOCAL_SOCKET=${DOCKER_ALLOW_LOCAL_SOCKET:-}');
    expect(env).not.toContain('DOCKER_HOST=tcp://docker-proxy:2375');
  });

  // Nothing in the image reads a compose file, and a short-syntax bind whose source is missing (the
  // stack started with `-f other.yml`) makes Docker create an empty host directory in its place.
  it('mounts only the data volume into openwa-api', () => {
    expect(compose.services['openwa-api'].volumes).toEqual(['openwa-data:/app/data']);
  });
});
