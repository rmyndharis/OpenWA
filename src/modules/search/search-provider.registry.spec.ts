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
    // A plugin re-enable registers the same id again: no duplicate, and the active choice stands.
    r.register(mk('a'));
    expect(r.active()?.id).toBe('b');
    expect(r.list()).toHaveLength(2);
    expect(() => r.setActive('zz')).toThrow(/unknown search provider/);
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

  it('get looks up a provider by id and returns null when absent', () => {
    const r = new SearchProviderRegistry();
    const a = mk('a');
    r.register(a);
    expect(r.get('a')).toBe(a);
    expect(r.get('missing')).toBeNull();
  });
});
