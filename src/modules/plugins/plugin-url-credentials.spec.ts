import { BadRequestException } from '@nestjs/common';
import { PluginsService } from './plugins.service';

// The download and the catalog read go through the SSRF-guarded fetch. A public IP literal keeps the run offline:
// the credentials are refused before any connection is made.
describe('PluginsService: a URL with credentials', () => {
  const SECRET = 's3cr3t-token';
  const REFUSAL = 'URL must not contain credentials (userinfo)';

  const serviceWith = (config: Record<string, unknown>): PluginsService => {
    const service = Object.create(PluginsService.prototype) as PluginsService;
    (service as unknown as { configService: unknown }).configService = { get: (key: string) => config[key] };
    return service;
  };

  const failure = async (run: () => Promise<unknown>): Promise<BadRequestException> => {
    const error = await run().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    return error as BadRequestException;
  };

  it('refuses a catalog URL with credentials without repeating them', async () => {
    const service = serviceWith({ 'plugins.catalogUrl': `https://ops:${SECRET}@93.184.216.34/plugins.json` });

    const error = await failure(() => service.getCatalog());

    expect(error.message).toBe(`Failed to fetch plugin catalog: ${REFUSAL}`);
    expect(error.message).not.toContain(SECRET);
  });

  it('refuses an install URL with credentials without repeating them', async () => {
    const service = serviceWith({});

    const error = await failure(() =>
      (service as unknown as { downloadPackage(url: string): Promise<Buffer> }).downloadPackage(
        `https://ops:${SECRET}@93.184.216.34/plugin.zip#sha256=${'a'.repeat(64)}`,
      ),
    );

    expect(error.message).toBe(`Failed to download plugin from URL: ${REFUSAL}`);
    expect(error.message).not.toContain(SECRET);
  });
});
