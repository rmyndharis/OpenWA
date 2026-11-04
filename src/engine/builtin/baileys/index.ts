/**
 * Baileys Engine Plugin
 * Built-in engine plugin that wraps the @whiskeysockets/baileys library.
 */

import { PluginContext, PluginType, IEnginePlugin } from '../../../core/plugins';
import { IWhatsAppEngine } from '../../interfaces/whatsapp-engine.interface';
import { BaileysAdapter } from '../../adapters/baileys.adapter';
import { BaileysMessageStore } from '../../types/baileys.types';
import { LidMappingStore } from '../../identity/lid-mapping-store.service';
import { ChatStateStore } from '../../adapters/baileys-chat-state-store.service';

export class BaileysPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  // RegisteredConfig (the engine config blob) is also supplied at construction so createEngine
  // has operator config even if enablePlugin fails before onLoad runs (this.context stays unset). The
  // healthy path still prefers context.config (it carries any persisted-override merge).
  constructor(
    private readonly messageStore?: BaileysMessageStore,
    private readonly registeredConfig?: Record<string, unknown>,
    private readonly lidMappingStore?: LidMappingStore,
    private readonly chatStateStore?: ChatStateStore,
  ) {}

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('Baileys engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('Baileys engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('Baileys engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const sessionId = config.sessionId as string;
    const dbSessionId = config.dbSessionId as string;
    const proxyUrl = config.proxyUrl as string | undefined;

    // Baileys' own config namespace, read from the opaque per-engine blob the factory supplies via
    // context.config (the `engine` sub-tree in configuration.ts). Per-call config carries
    // engine-neutral fields (sessionId, proxy) plus authDir, the base the factory hardens and purges,
    // which wins over context.config.
    const engineConfig = (this.context?.config ?? this.registeredConfig ?? {}) as { baileys?: { authDir?: string } };
    const authDir = (config.authDir as string | undefined) ?? engineConfig.baileys?.authDir ?? './data/baileys';

    return new BaileysAdapter({
      sessionId,
      dbSessionId,
      authDir,
      proxyUrl,
      messageStore: this.messageStore,
      lidMappingStore: this.lidMappingStore,
      chatStateStore: this.chatStateStore,
    });
  }

  getFeatures(): string[] {
    return [
      'text-messages',
      'typing-indicator',
      'media-messages',
      'location-messages',
      'contact-messages',
      'message-replies',
      'message-forwarding',
      'message-reactions',
      'message-deletion',
      'group-management',
      'read-receipts',
      'channels',
      'status-updates',
      'catalog',
      // No 'labels': Baileys can create, delete and attach labels but has no query for them, so the
      // label and chat-label reads 501 and a client could not read back what it wrote.
    ];
  }

  getEngineLibrary(): { name: string; version: string } {
    let version = 'unknown';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      version = (require('@whiskeysockets/baileys/package.json') as { version: string }).version;
    } catch {
      // Keep 'unknown' if the package metadata can't be resolved at runtime.
    }
    return { name: '@whiskeysockets/baileys', version };
  }

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return Promise.resolve({ healthy: true, message: 'Baileys engine is available' });
  }
}

export default BaileysPlugin;
