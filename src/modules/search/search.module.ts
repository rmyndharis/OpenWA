import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';

/**
 * Wires the global search feature: the route (SearchController), the service layer (SearchService),
 * the provider registry, and the built-in DB-native FTS provider. A `SEARCH_BOOTSTRAP` factory runs
 * at DI time to register `builtin-fts` and make it the active provider (the registry's register()
 * also auto-promotes the first provider to active, so the explicit setActive is belt-and-braces —
 * pinning the built-in even when SEARCH_PROVIDER is `builtin-fts` rather than `auto`).
 *
 * The module is imported by AppModule only when `SEARCH_ENABLED !== 'false'`, so the route + provider
 * are entirely absent when disabled (zero footprint — no 501 risk, no DI wiring). Plugin providers
 * (Spec 2) will register themselves the same way and `auto` will select a healthy plugin over builtin.
 */
@Module({
  imports: [ConfigModule],
  controllers: [SearchController],
  providers: [
    SearchProviderRegistry,
    SearchService,
    BuiltInFtsProvider,
    {
      provide: 'SEARCH_BOOTSTRAP',
      inject: [SearchProviderRegistry, BuiltInFtsProvider, ConfigService],
      useFactory: (registry: SearchProviderRegistry, builtin: BuiltInFtsProvider, cfg: ConfigService) => {
        const provider = cfg.get<string>('search.provider', 'auto');
        registry.register(builtin);
        // register() already makes the first provider active; pin it explicitly when configured to,
        // so `auto` and `builtin-fts` both resolve to a working /search (not 501).
        if (provider === 'builtin-fts' || provider === 'auto') {
          registry.setActive('builtin-fts');
        }
        return registry;
      },
    },
  ],
})
export class SearchModule {}
