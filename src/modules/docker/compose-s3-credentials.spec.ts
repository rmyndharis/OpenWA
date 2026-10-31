import { readFileSync } from 'fs';
import { join } from 'path';

// js-yaml has no bundled types here; require + cast (matches the compose-parity.spec.ts pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

/**
 * The storage layer reads S3_ACCESS_KEY / S3_SECRET_KEY when the canonical pair is unset, and
 * .env.example promises older setups keep working. A Compose file only passes on the variables it
 * lists, so one that forwards just the canonical pair leaves such a setup without credentials.
 */
describe.each(['docker-compose.yml', 'docker-compose.dev.yml'])('%s forwards the S3 credentials', file => {
  const compose = yaml.load(readFileSync(join(__dirname, '../../..', file), 'utf8')) as {
    services: Record<string, { environment?: string[] | Record<string, string> }>;
  };
  // docker-proxy and minio list their environment as a map; the API service lists it as KEY=value.
  const api = Object.values(compose.services).find(
    service => Array.isArray(service.environment) && service.environment.some(e => e.startsWith('S3_ACCESS_KEY_ID=')),
  );

  it('finds the service that carries the canonical pair', () => {
    expect(api).toBeDefined();
  });

  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'])('forwards %s', name => {
    expect(api?.environment).toContain(`${name}=\${${name}:-}`);
  });
});
