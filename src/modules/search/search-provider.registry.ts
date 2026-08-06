import { Injectable } from '@nestjs/common';
import type { SearchProvider } from './search.types';

/**
 * Holds the set of registered SearchProviders and the currently active one.
 * Core registers `builtin-fts` at bootstrap; plugins (Spec 2) register themselves.
 * active() returns null when nothing is registered → the route 501s.
 */
@Injectable()
export class SearchProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();
  private activeId: string | null = null;

  register(provider: SearchProvider): void {
    this.providers.set(provider.id, provider);
    if (this.activeId === null) this.activeId = provider.id;
  }

  unregister(id: string): void {
    this.providers.delete(id);
    if (this.activeId === id) {
      this.activeId = Array.from(this.providers.keys())[0] ?? null;
    }
  }

  setActive(id: string): void {
    if (!this.providers.has(id)) throw new Error(`unknown search provider: ${id}`);
    this.activeId = id;
  }

  active(): SearchProvider | null {
    return this.activeId === null ? null : (this.providers.get(this.activeId) ?? null);
  }

  list(): SearchProvider[] {
    return [...this.providers.values()];
  }
}
