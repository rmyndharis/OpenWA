import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { PluginLoaderService, PluginManifest, PluginType } from '../../core/plugins';
import { AutoReplyPlugin } from './auto-reply';
import { TranslationPlugin } from './translation';
import { createLogger } from '../../common/services/logger.service';

/**
 * Registers first-party built-in EXTENSION plugins with the (global) PluginLoaderService.
 * Mirrors EngineFactory's registration pattern so src/core never imports a concrete plugin.
 * Built-in extensions are registered DISABLED; operators enable them via POST /plugins/:id/enable.
 */
@Injectable()
export class ExtensionsRegistrar implements OnModuleInit {
  private readonly logger = createLogger('ExtensionsRegistrar');

  constructor(private readonly pluginLoader: PluginLoaderService) {}

  onModuleInit(): void {
    const autoReplyManifest: PluginManifest = {
      id: 'auto-reply',
      name: 'Auto Reply (reference)',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      description: 'Reference extension plugin: replies to inbound direct messages. Disabled by default.',
      main: 'index.ts',
      permissions: ['messages:send'],
      sessions: ['*'],
    };

    this.pluginLoader.registerBuiltInPlugin(autoReplyManifest, new AutoReplyPlugin());
    this.logger.log('Auto-reply reference plugin registered (disabled)');

    const translationManifest: PluginManifest = {
      id: 'translation',
      name: 'Group Auto-Translation',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      description:
        "Auto-translates group messages between participants' languages via LibreTranslate. Configure in-group with /tr commands. Disabled by default.",
      main: 'index.ts',
      // Sends translations (messages:send) and reads group admins via ctx.engine.getGroupInfo (engine:read).
      permissions: ['messages:send', 'engine:read'],
      sessions: ['*'],
      // Exposed via GET /plugins so the dashboard renders an editable config form (URL + API key, etc.).
      configSchema: {
        type: 'object',
        properties: {
          libretranslateUrl: {
            type: 'string',
            title: 'LibreTranslate URL',
            description:
              'Base URL of the LibreTranslate instance (e.g. http://libretranslate:7001 or https://libretranslate.com).',
            default: 'http://localhost:7001',
            required: true,
          },
          libretranslateApiKey: {
            type: 'string',
            title: 'LibreTranslate API key',
            description:
              'Optional API key, if your LibreTranslate instance requires one (e.g. hosted libretranslate.com).',
            secret: true,
          },
          timeoutMs: { type: 'number', title: 'Translate timeout (ms)', default: 5000 },
          commandPrefix: { type: 'string', title: 'Command prefix', default: '/tr' },
          minLength: { type: 'number', title: 'Min message length to translate', default: 2 },
          maxLength: { type: 'number', title: 'Max message length to translate', default: 2000 },
          denyReply: {
            type: 'boolean',
            title: 'Reply on denied commands',
            description: "Reply with an 'admins only' message when a non-admin runs a restricted command.",
            default: false,
          },
        },
      },
    };

    this.pluginLoader.registerBuiltInPlugin(translationManifest, new TranslationPlugin());
    this.logger.log('Translation plugin registered (disabled)');
  }
}

@Module({
  providers: [ExtensionsRegistrar],
})
export class ExtensionsModule {}
