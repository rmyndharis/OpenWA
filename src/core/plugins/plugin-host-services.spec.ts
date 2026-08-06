import { PluginHostServices } from './plugin-host-services';
import { SearchProviderRegistry } from '../../modules/search/search-provider.registry';
import type { ModuleRef } from '@nestjs/core';

const hostServices = (get: jest.Mock): PluginHostServices => new PluginHostServices({ get } as unknown as ModuleRef);

describe('PluginHostServices', () => {
  describe('getSearchRegistry', () => {
    it('returns the registry when ModuleRef has it', () => {
      const registry = new SearchProviderRegistry();

      expect(hostServices(jest.fn().mockReturnValue(registry)).getSearchRegistry()).toBe(registry);
    });

    it('returns undefined when ModuleRef has no registry (search disabled)', () => {
      // SEARCH_ENABLED=false omits SearchModule entirely, so the lookup throws rather than missing.
      // Callers no-op on undefined; letting it propagate would break plugin enable for everyone.
      const get = jest.fn().mockImplementation(() => {
        throw new Error('not found');
      });

      expect(hostServices(get).getSearchRegistry()).toBeUndefined();
    });
  });
});
