import { registerPluginSearchProvider, unregisterPluginSearchProvider } from './search-provider-registration.util';
import { SearchProviderRegistry } from '../../modules/search/search-provider.registry';
import type { PluginSearchTransport } from '../../modules/search/providers/plugin-search-provider';

const mkTransport = (): PluginSearchTransport => ({ dispatchSearch: jest.fn(), healthCheck: jest.fn() });

const deps = (overrides: Partial<Parameters<typeof registerPluginSearchProvider>[0]> = {}) => ({
  pluginId: 'meili',
  label: 'Meilisearch (plugin)',
  transport: mkTransport(),
  timeoutMs: 10000,
  registry: new SearchProviderRegistry(),
  mode: 'auto',
  ...overrides,
});

const builtin = () => ({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });

describe('registerPluginSearchProvider', () => {
  it('auto mode registers and activates the plugin, superseding builtin-fts', () => {
    const registry = new SearchProviderRegistry();
    registry.register(builtin());
    expect(registry.active()?.id).toBe('builtin-fts');

    registerPluginSearchProvider(deps({ registry }));

    expect(registry.list().map(p => p.id)).toContain('plugin:meili');
    expect(registry.active()?.id).toBe('plugin:meili');
  });

  it('builtin-fts mode registers the plugin but leaves builtin active', () => {
    const registry = new SearchProviderRegistry();
    registry.register(builtin());

    registerPluginSearchProvider(deps({ registry, mode: 'builtin-fts' }));

    expect(registry.list().map(p => p.id)).toContain('plugin:meili');
    expect(registry.active()?.id).toBe('builtin-fts');
  });

  it('none mode skips registration entirely', () => {
    const registry = new SearchProviderRegistry();

    registerPluginSearchProvider(deps({ registry, mode: 'none' }));

    expect(registry.list().map(p => p.id)).not.toContain('plugin:meili');
    expect(registry.active()).toBeNull();
  });

  it('undefined registry (search module not loaded) skips without throwing', () => {
    expect(() => registerPluginSearchProvider(deps({ registry: undefined }))).not.toThrow();
  });
});

describe('unregisterPluginSearchProvider', () => {
  it('removes the plugin:<id> provider and falls back', () => {
    const registry = new SearchProviderRegistry();
    registry.register(builtin());
    registerPluginSearchProvider(deps({ registry })); // active = plugin:meili

    unregisterPluginSearchProvider(registry, 'meili');

    expect(registry.list().map(p => p.id)).not.toContain('plugin:meili');
    expect(registry.active()?.id).toBe('builtin-fts');
  });

  it('is a no-op when the registry is absent', () => {
    expect(() => unregisterPluginSearchProvider(undefined, 'meili')).not.toThrow();
  });
});
