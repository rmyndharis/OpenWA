import type { ModuleRef } from '@nestjs/core';
import type { MessageService } from '../../modules/message/message.service';
import type { SessionService } from '../../modules/session/session.service';
import type { ConversationMappingService } from '../../modules/integration/conversation-mapping.service';
import type { PluginInstanceService } from '../../modules/integration/plugin-instance.service';
import type { SearchProviderRegistry } from '../../modules/search/search-provider.registry';

/**
 * Resolves the host services a plugin capability reaches, at call time rather than at module load.
 *
 * Every lookup here is a lazy `require` plus a non-strict `ModuleRef.get`, and both halves are
 * load-bearing:
 *
 * - The lazy require exists so this file creates NO top-level module edge to the services. A static
 *   import of MessageService closes the cycle
 *   `plugin-loader -> message -> session -> engine.factory -> core/plugins barrel -> plugin-loader`,
 *   which corrupts MessageService's constructor paramtype metadata (`SessionService -> undefined`)
 *   at boot. The same reasoning covers the two integration services.
 * - `ModuleRef` rather than constructor injection avoids the provider cycle
 *   `PluginLoaderService -> SessionService -> SessionEngineLifecycle -> EngineFactory -> PluginLoaderService`.
 *
 * Keeping the pair in one place means the loader no longer has to carry that reasoning, nor name the
 * five services it was resolving. Everything below is a resolution detail; nothing here decides
 * policy.
 */
export class PluginHostServices {
  constructor(private readonly moduleRef: ModuleRef) {}

  getMessageService(): MessageService {
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/message/message.service') as typeof import('../../modules/message/message.service');
    return this.moduleRef.get(mod.MessageService, { strict: false });
  }

  getSessionService(): SessionService {
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/session/session.service') as typeof import('../../modules/session/session.service');
    return this.moduleRef.get(mod.SessionService, { strict: false });
  }

  getConversationMappingService(): ConversationMappingService {
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/integration/conversation-mapping.service') as typeof import('../../modules/integration/conversation-mapping.service');
    return this.moduleRef.get(mod.ConversationMappingService, { strict: false });
  }

  getPluginInstanceService(): PluginInstanceService {
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/integration/plugin-instance.service') as typeof import('../../modules/integration/plugin-instance.service');
    return this.moduleRef.get(mod.PluginInstanceService, { strict: false });
  }

  /**
   * Search is conditionally loaded (`SEARCH_ENABLED=false` omits SearchModule), so the registry may
   * not be registered at all. Returns undefined in that case so callers can no-op rather than throw.
   */
  getSearchRegistry(): SearchProviderRegistry | undefined {
    try {
      const mod =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../modules/search/search-provider.registry') as typeof import('../../modules/search/search-provider.registry');
      return this.moduleRef.get(mod.SearchProviderRegistry, { strict: false });
    } catch {
      return undefined;
    }
  }
}
