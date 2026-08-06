import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';

/**
 * Wires the global search feature: the route (SearchController), the service layer (SearchService),
 * the provider registry, and the built-in DB-native FTS provider. The `SEARCH_BOOTSTRAP` factory runs
 * at DI time via `bootstrapSearchProviders` to register `builtin-fts` and make it the active provider.
 *
 * `SEARCH_PROVIDER=none` is honored by leaving the registry empty: the module (and route) stay loaded
 * but `SearchService.search()` throws NotImplementedException → /search returns 501. This is distinct
 * from `SEARCH_ENABLED=false`, which omits the module entirely (route 404).
 *
 * The module is imported by AppModule only when `SEARCH_ENABLED !== 'false'`. Plugin providers
 * (Spec 2) will register themselves the same way and `auto` will select a healthy plugin over builtin.
 */
export function bootstrapSearchProviders(
  registry: SearchProviderRegistry,
  builtin: BuiltInFtsProvider,
  cfg: ConfigService,
): SearchProviderRegistry {
  const provider = cfg.get<string>('search.provider', 'auto');
  // `none` keeps the route mounted but registers no provider, so registry.active() is null and
  // SearchService.search() throws NotImplementedException → /search returns 501 (not live results).
  if (provider === 'none') return registry;
  registry.register(builtin);
  // register() auto-promotes the first provider to active; the explicit setActive is belt-and-braces
  // for `builtin-fts` (a no-op for `auto`, which register() already activated).
  if (provider === 'builtin-fts') {
    registry.setActive('builtin-fts');
  }
  return registry;
}

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
      useFactory: bootstrapSearchProviders,
    },
  ],
})
export class SearchModule {}
