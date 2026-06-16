/**
 * WhatsApp-web.js Engine Plugin
 * Built-in engine plugin that wraps the whatsapp-web.js library
 */

import { PluginContext, PluginType, IEnginePlugin } from '../../../core/plugins';
import { IWhatsAppEngine } from '../../../engine/interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from '../../../engine/adapters/whatsapp-web-js.adapter';

export interface WhatsAppWebJsConfig {
  sessionDataPath?: string;
  headless?: boolean;
  puppeteerArgs?: string[];
  executablePath?: string;
}

export class WhatsAppWebJsPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

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
    // Prefer the per-call config resolved by EngineFactory (from ConfigService);
    // fall back to any plugin-level context config, then to safe defaults. The
    // built-in plugin registers with an empty context config, so without the
    // per-call values sessionDataPath/headless/executablePath would silently
    // fall back to relative-path defaults and ignore the environment.
    const sessionDataPath =
      (config.sessionDataPath as string | undefined) ??
      (this.context?.config.sessionDataPath as string | undefined) ??
      './data/sessions';
    const headless =
      (config.headless as boolean | undefined) ?? (this.context?.config.headless as boolean | undefined) ?? true;
    const puppeteerArgs = (config.puppeteerArgs as string[] | undefined) ??
      (this.context?.config.puppeteerArgs as string[] | undefined) ?? ['--no-sandbox', '--disable-setuid-sandbox'];
    const executablePath =
      (config.executablePath as string | undefined) ?? (this.context?.config.executablePath as string | undefined);

    const proxyUrl = config.proxyUrl as string | undefined;
    const proxyType = config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined;

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
