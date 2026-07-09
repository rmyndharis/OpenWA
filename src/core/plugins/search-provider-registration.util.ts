import { PluginSearchProvider } from '../../modules/search/providers/plugin-search-provider';
import type { PluginSearchTransport } from '../../modules/search/providers/plugin-search-provider';
import type { SearchProviderRegistry } from '../../modules/search/search-provider.registry';

export interface RegisterPluginSearchProviderDeps {
  pluginId: string;
  label: string;
  transport: PluginSearchTransport;
  timeoutMs: number;
  /** The live SearchProviderRegistry, or undefined when the search module isn't loaded (SEARCH_ENABLED=false). */
  registry: SearchProviderRegistry | undefined;
  /** Resolved SEARCH_PROVIDER mode: 'auto' | 'builtin-fts' | 'none'. */
  mode: string;
}

/**
 * Register a sandboxed plugin as a SearchProvider when it declares itself one (search-provider-register).
 * Pure policy, extracted from the loader so it is unit-testable without constructing PluginLoaderService:
 *
 * - registry undefined → search module not loaded (SEARCH_ENABLED=false); skip silently.
 * - mode 'none'        → operator disabled search; skip.
 * - mode 'auto'        → register AND setActive, superseding builtin-fts (the documented auto behavior).
 * - mode 'builtin-fts' → register but leave inactive (operator pinned the built-in).
 *
 * Last-registered plugin wins in 'auto' if multiple register (Part 1 limitation).
 */
export function registerPluginSearchProvider(deps: RegisterPluginSearchProviderDeps): void {
  if (!deps.registry) return;
  if (deps.mode === 'none') return;
  const provider = new PluginSearchProvider(deps.pluginId, deps.label, deps.transport, deps.timeoutMs);
  deps.registry.register(provider);
  if (deps.mode === 'auto') deps.registry.setActive(provider.id);
}

/** Drop a plugin's SearchProvider entry on disable/uninstall so queries don't route to a dead worker. */
export function unregisterPluginSearchProvider(registry: SearchProviderRegistry | undefined, pluginId: string): void {
  registry?.unregister(`plugin:${pluginId}`);
}
