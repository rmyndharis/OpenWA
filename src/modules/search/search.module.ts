import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';
import { PLUGIN_SEARCH_REGISTRY_PORT } from '../../core/plugins/plugin-host-ports';

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
 * register themselves through the same registry; in `auto` mode the most recently registered plugin
 * supersedes builtin (no health gating).
 *
 * Global and exporting SearchService so the agent-tool registry (MessageSearch) can inject it as an
 * optional dependency: importing this module there would load search even when SEARCH_ENABLED=false
 * asks for it to be absent.
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

@Global()
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
    // Binds the core-owned plugin capability port to this module's registry; resolved lazily by the
    // plugin runtime (PluginHostServices), which no-ops when this whole module is omitted
    // (SEARCH_ENABLED=false).
    // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
    { provide: PLUGIN_SEARCH_REGISTRY_PORT, useExisting: SearchProviderRegistry },
  ],
  exports: [SearchService],
})
export class SearchModule {}
