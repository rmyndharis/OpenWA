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
}

export class WhatsAppWebJsPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;
  private readonly defaultPuppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
  ];

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

  private parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  }

  private parseArgs(input: unknown): string[] {
    if (Array.isArray(input)) {
      return input.map(arg => String(arg).trim()).filter(Boolean);
    }

    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return [];
      if (trimmed.includes(',')) {
        return trimmed
          .split(',')
          .map(arg => arg.trim())
          .filter(Boolean);
      }
      return trimmed
        .split(/\s+/)
        .map(arg => arg.trim())
        .filter(Boolean);
    }

    return [];
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const sessionId = config.sessionId as string;
    const sessionDataPath =
      (this.context?.config.sessionDataPath as string) ||
      process.env.SESSION_DATA_PATH ||
      process.env.ENGINE_SESSION_PATH ||
      './data/sessions';

    const headless = this.parseBoolean(
      this.context?.config.headless ?? process.env.PUPPETEER_HEADLESS ?? process.env.ENGINE_HEADLESS,
      true,
    );

    const contextArgsPrimary = this.parseArgs(this.context?.config.puppeteerArgs);
    const contextArgsFallback = this.parseArgs(this.context?.config.browserArgs);
    const contextArgs = contextArgsPrimary.length > 0 ? contextArgsPrimary : contextArgsFallback;
    const envArgs = this.parseArgs(process.env.PUPPETEER_ARGS || process.env.ENGINE_BROWSER_ARGS || '');
    const puppeteerArgs =
      contextArgs.length > 0 ? contextArgs : envArgs.length > 0 ? envArgs : this.defaultPuppeteerArgs;

    const proxyUrl = config.proxyUrl as string | undefined;
    const proxyType = config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined;

    return new WhatsAppWebJsAdapter({
      sessionId,
      sessionDataPath,
      puppeteer: {
        headless,
        args: puppeteerArgs,
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
