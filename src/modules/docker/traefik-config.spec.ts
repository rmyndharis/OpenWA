import { readFileSync } from 'fs';
import { join } from 'path';
// js-yaml has no bundled types here; require + cast (matches the repo's plugin-loader pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface TraefikConfig {
  api?: { insecure?: boolean };
  entryPoints?: Record<string, { address?: string }>;
}

/** Regression lock: the Traefik dashboard must not be served insecurely + TLS exists. */
describe('traefik static config', () => {
  const cfg = yaml.load(readFileSync(join(__dirname, '../../../traefik/traefik.yml'), 'utf8')) as TraefikConfig;

  it('does not enable the insecure API dashboard', () => {
    expect(cfg.api?.insecure).toBe(false);
  });

  it('defines a TLS (websecure) entrypoint', () => {
    expect(cfg.entryPoints?.websecure?.address).toBe(':443');
  });
});
