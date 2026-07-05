/**
 * WhatsApp-web.js Engine Plugin
 * Built-in engine plugin that wraps the whatsapp-web.js library
 */

import { PluginContext, PluginType, IEnginePlugin } from '../../../core/plugins';
import { IWhatsAppEngine } from '../../../engine/interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from '../../../engine/adapters/whatsapp-web-js.adapter';
import { LidMappingStore } from '../../../engine/identity/lid-mapping-store.service';

export class WhatsAppWebJsPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  // The engine config blob is also supplied at construction so createEngine has operator
  // config even if enablePlugin fails before onLoad runs (which would leave this.context unset).
  // The healthy path still prefers context.config (it carries any persisted-override merge).
  constructor(
    private readonly registeredConfig?: Record<string, unknown>,
    // Shared lid<->phone table, threaded to the adapter so it can persist learned phone->lid pairs
    // (mirrors how BaileysPlugin receives it; #583 R3).
    private readonly lidMappingStore?: LidMappingStore,
  ) {}

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('WhatsApp-web.js engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('WhatsApp-web.js engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('WhatsApp-web.js engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const sessionId = config.sessionId as string;
    const proxyUrl = config.proxyUrl as string | undefined;
    const proxyType = config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined;

    // Browser config is this engine's OWN namespace, read from the opaque per-engine blob the
    // factory supplies via context.config (the `engine` sub-tree in configuration.ts). The
    // per-call config carries only engine-neutral fields (sessionId, proxy).
    const engineConfig = (this.context?.config ?? this.registeredConfig ?? {}) as {
      sessionDataPath?: string;
      puppeteer?: { headless?: boolean; args?: string[]; executablePath?: string };
    };
    const puppeteer = engineConfig.puppeteer ?? {};
    const sessionDataPath = engineConfig.sessionDataPath ?? './data/sessions';
    const headless = puppeteer.headless ?? true;
    const puppeteerArgs = puppeteer.args ?? ['--no-sandbox', '--disable-setuid-sandbox'];
    const executablePath = puppeteer.executablePath;

    return new WhatsAppWebJsAdapter({
      sessionId,
      sessionDataPath,
      puppeteer: {
        headless,
        args: puppeteerArgs,
        executablePath,
      },
      proxy: proxyUrl
        ? {
            url: proxyUrl,
            type: proxyType ?? 'http',
          }
        : undefined,
      lidMappingStore: this.lidMappingStore,
    });
  }

  getFeatures(): string[] {
    return [
      'text-messages',
      'media-messages',
      'location-messages',
      'contact-messages',
      'group-management',
      'message-reactions',
      'message-replies',
      'message-forwarding',
      'message-deletion',
      'read-receipts',
      'typing-indicator',
      'labels',
      'channels',
      'status-updates',
      'catalog',
    ];
  }

  getEngineLibrary(): { name: string; version: string } {
    // The actual whatsapp-web.js library version (e.g. 1.34.7), surfaced so operators can see which
    // engine version is really running — distinct from this adapter plugin's manifest version (1.0.0).
    let version = 'unknown';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      version = (require('whatsapp-web.js/package.json') as { version: string }).version;
    } catch {
      // Keep 'unknown' if the package metadata can't be resolved at runtime.
    }
    return { name: 'whatsapp-web.js', version };
  }

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return Promise.resolve({ healthy: true, message: 'WhatsApp-web.js engine is available' });
  }
}

export default WhatsAppWebJsPlugin;
