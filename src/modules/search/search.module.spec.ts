import { ConfigService } from '@nestjs/config';
import { bootstrapSearchProviders } from './search.module';
import { SearchProviderRegistry } from './search-provider.registry';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';
import type { SearchProvider } from './search.types';

/** A `builtin-fts`-shaped stand-in — avoids the DataSource dependency the real provider carries. */
function mkBuiltin(): BuiltInFtsProvider {
  const p: SearchProvider = { id: 'builtin-fts', label: 'Built-in FTS', search: jest.fn(), health: jest.fn() };
  return p as unknown as BuiltInFtsProvider;
}

function mockCfg(provider: string): ConfigService {
  return { get: jest.fn().mockReturnValue(provider) } as unknown as ConfigService;
}

describe('SearchModule bootstrap (SEARCH_PROVIDER gating)', () => {
  it('registers and activates builtin-fts for SEARCH_PROVIDER=auto', () => {
    const registry = new SearchProviderRegistry();
    bootstrapSearchProviders(registry, mkBuiltin(), mockCfg('auto'));
    expect(registry.active()?.id).toBe('builtin-fts');
    expect(registry.list().map(p => p.id)).toEqual(['builtin-fts']);
  });

  it('registers and activates builtin-fts for SEARCH_PROVIDER=builtin-fts', () => {
    const registry = new SearchProviderRegistry();
    bootstrapSearchProviders(registry, mkBuiltin(), mockCfg('builtin-fts'));
    expect(registry.active()?.id).toBe('builtin-fts');
  });

  it('does NOT register any provider for SEARCH_PROVIDER=none → active() is null (route 501, not live)', () => {
    // This is the fail-open guard: the route stays mounted, but with no active provider SearchService
    // throws NotImplementedException → /search returns 501 instead of serving results via builtin-fts.
    const registry = new SearchProviderRegistry();
    bootstrapSearchProviders(registry, mkBuiltin(), mockCfg('none'));
    expect(registry.active()).toBeNull();
    expect(registry.list()).toHaveLength(0);
  });
});
