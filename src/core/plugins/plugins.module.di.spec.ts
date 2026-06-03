import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { HooksModule } from '../hooks';
import { PluginCircuitBreaker } from '../hooks/plugin-circuit-breaker.service';
import { PluginsModule } from './plugins.module';
import { PluginLoaderService } from './plugin-loader.service';
import configuration from '../../config/configuration';

/**
 * Guards the Tier-1 C1 isolation wiring: PluginLoaderService takes
 * PluginCircuitBreaker as a 4th constructor param, resolved from the @Global
 * HooksModule. A regression in provider/export wiring would fail here with a
 * Nest dependency-resolution error rather than at runtime boot.
 */
describe('PluginsModule DI wiring', () => {
  it('resolves PluginLoaderService with an injected PluginCircuitBreaker', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ load: [configuration], isGlobal: true }), HooksModule, PluginsModule],
    }).compile();

    const loader = moduleRef.get(PluginLoaderService);
    const breaker = moduleRef.get(PluginCircuitBreaker);

    expect(loader).toBeInstanceOf(PluginLoaderService);
    expect(breaker).toBeInstanceOf(PluginCircuitBreaker);

    await moduleRef.close();
  });
});
