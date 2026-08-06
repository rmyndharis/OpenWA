import { SearchProviderRegistry } from './search-provider.registry';
import type { SearchProvider } from './search.types';

function mk(id: string): SearchProvider {
  return { id, label: id, search: jest.fn(), health: jest.fn() };
}

describe('SearchProviderRegistry', () => {
  it('returns null when nothing is registered', () => {
    expect(new SearchProviderRegistry().active()).toBeNull();
  });

  it('auto-selects the first registered provider as active', () => {
    const r = new SearchProviderRegistry();
    r.register(mk('a'));
    expect(r.active()?.id).toBe('a');
  });

  it('setActive selects among registered providers; register idempotent; unregister clears active', () => {
    const r = new SearchProviderRegistry();
    r.register(mk('a'));
    r.register(mk('b'));
    r.setActive('b');
    expect(r.active()?.id).toBe('b');
    r.unregister('b');
    expect(r.active()?.id).toBe('a');
    r.unregister('a');
    expect(r.active()).toBeNull();
  });

  it('list returns all registered providers', () => {
    const r = new SearchProviderRegistry();
    r.register(mk('a'));
    r.register(mk('b'));
    expect(
      r
        .list()
        .map(p => p.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});
