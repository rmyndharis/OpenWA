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
    const sessionDataPath = (this.context?.config.sessionDataPath as string) ?? './data/sessions';
    const headless = (this.context?.config.headless as boolean) ?? true;
    const puppeteerArgs = (this.context?.config.puppeteerArgs as string[]) ?? [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ];

    const proxyUrl = config.proxyUrl as string | undefined;
    const proxyType = config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined;

    return new WhatsAppWebJsAdapter({
      sessionId,
      sessionDataPath,
      puppeteer: {
        headless,
        args: puppeteerArgs,
        // Undefined here falls through to PUPPETEER_EXECUTABLE_PATH inside the adapter.
        executablePath: this.context?.config.executablePath as string | undefined,
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

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return Promise.resolve({ healthy: true, message: 'WhatsApp-web.js engine is available' });
  }
}

export default WhatsAppWebJsPlugin;
