import * as fs from 'fs';
import * as path from 'path';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { PluginLoaderService, PluginType, IEnginePlugin, PluginManifest } from '../core/plugins';
import { WhatsAppWebJsPlugin } from './builtin/whatsapp-web-js';
import { BaileysPlugin } from './builtin/baileys';
import { createLogger } from '../common/services/logger.service';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { ChatStateStoreService } from './adapters/baileys-chat-state-store.service';
import { isSafeSessionName } from '../common/utils/path-safety';
import { ensurePrivateDir } from '../common/utils/private-dir.util';
import { baileysAuthDir, readAuthDirEntries, wwjsAuthDir } from './auth-dir-paths';

export interface EngineCreateOptions {
  /**
   * Session UUID (Session.id): the on-disk auth-directory key (matches the dirs purgeSessionData
   * removes), and what the adapters stamp on their per-session rows and logs. Carries the same value
   * as `dbSessionId`; both stay in the per-call config because an out-of-tree engine plugin reads
   * them by name.
   */
  sessionId: string;
  /** Session UUID (Session.id) — the DB-row key for FK-bound stores (e.g. baileys_stored_messages). */
  dbSessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

@Injectable()
export class EngineFactory implements OnModuleInit {
  private readonly logger = createLogger('EngineFactory');
  private readonly engineType: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly pluginLoader: PluginLoaderService,
    private readonly baileysMessageStore: BaileysMessageStoreService,
    private readonly lidMappingStore: LidMappingStoreService,
    private readonly chatStateStore: ChatStateStoreService,
  ) {
    this.engineType = this.configService.get<string>('engine.type') ?? 'whatsapp-web.js';
  }

  async onModuleInit(): Promise<void> {
    // Register built-in engine plugins
    await this.registerBuiltInEngines();
  }

  private async registerBuiltInEngines(): Promise<void> {
    // The engine config sub-tree (engine.* from configuration.ts) as an opaque blob. Supplied BOTH
    // to registerBuiltInPlugin (becomes context.config when onLoad runs) AND to each plugin's
    // constructor (A fallback so createEngine still has operator config if enablePlugin fails
    // before onLoad — otherwise sessionDataPath/executablePath/authDir would silently drop to defaults).
    const engineConfig = this.configService.get<Record<string, unknown>>('engine') ?? {};

    // Register WhatsApp-web.js as built-in plugin
    const wwjsManifest: PluginManifest = {
      id: 'whatsapp-web.js',
      name: 'WhatsApp Web.js Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Official WhatsApp-web.js engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };

    const wwjsPlugin = new WhatsAppWebJsPlugin(engineConfig, this.lidMappingStore);
    this.pluginLoader.registerBuiltInPlugin(wwjsManifest, wwjsPlugin, engineConfig);

    // Register Baileys as a second built-in engine plugin. Same opaque engine blob; the plugin
    // reads only its own namespace (baileys.authDir) from context.config.
    const baileysManifest: PluginManifest = {
      id: 'baileys',
      name: 'Baileys Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Baileys (WebSocket, no-browser) engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };
    this.pluginLoader.registerBuiltInPlugin(
      baileysManifest,
      new BaileysPlugin(this.baileysMessageStore, engineConfig, this.lidMappingStore, this.chatStateStore),
      engineConfig,
    );

    // Auto-enable the configured engine
    try {
      await this.pluginLoader.enablePlugin(this.engineType);
      this.logger.log(`Engine plugin enabled: ${this.engineType}`, {
        action: 'engine_enabled',
        engineType: this.engineType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enable engine plugin: ${this.engineType}`,
        error instanceof Error ? error.message : String(error),
        { action: 'engine_enable_failed' },
      );
    }
  }

  create(options: EngineCreateOptions): IWhatsAppEngine {
    // The sessionId becomes the engine's on-disk auth-directory key (path.join(authDir, sessionId) /
    // session-${sessionId}), so a value containing '.', '/' or '\\' could traverse outside it. It is a
    // Session.id (a UUID) on every in-tree path, but a restored/imported row carries whatever its
    // archive held — assert here so the traversal can never materialize regardless of source.
    if (!isSafeSessionName(options.sessionId)) {
      throw new Error(`Refusing to create an engine for an unsafe session key: ${JSON.stringify(options.sessionId)}`);
    }

    // Both engine shapes' credential dirs are made owner-only up front, whichever engine this
    // session runs and whichever construction path serves it (plugin or fallback): a whatsapp-web.js
    // profile and a baileys creds.json each hold everything needed to take over the linked account,
    // so read access to the data volume must not be enough. Mirrors purgeSessionData, which removes
    // BOTH shapes for the same engine-switch-residue reason.
    ensurePrivateDir(this.wwjsAuthDir(options.sessionId));
    ensurePrivateDir(this.baileysAuthDir(options.sessionId));

    // Try to get engine from plugin system
    const enginePlugin = this.pluginLoader.getPlugin(this.engineType);

    if (enginePlugin?.instance && this.isEnginePlugin(enginePlugin.instance)) {
      // Engine-neutral per-call config only. Engine-specific config (e.g. Puppeteer for
      // whatsapp-web.js) is supplied to the plugin as an opaque blob via context.config at
      // registration, so the factory never assembles browser-shaped fields.
      return enginePlugin.instance.createEngine({
        sessionId: options.sessionId,
        dbSessionId: options.dbSessionId,
        proxyUrl: options.proxyUrl,
        proxyType: options.proxyType,
      }) as IWhatsAppEngine;
    }

    // Fallback to direct adapter creation (legacy support)
    this.logger.warn(`Engine plugin ${this.engineType} not available, using fallback`, {
      action: 'engine_fallback',
    });

    return this.createFallbackEngine(options);
  }

  /**
   * Remove a session's persistent on-disk auth/store directories so deleting a session fully purges
   * its footprint. The dir is keyed by session ID — the same key {@link create} uses
   * (`path.join(authDir, id)` for baileys, `session-${id}` under sessionDataPath for
   * whatsapp-web.js) — and survives independently of any engine instance. On delete the engine is
   * frequently not even loaded (a stopped session has none), so the paths are derived from config
   * here rather than from a live adapter; otherwise the residue would sit on the volume forever.
   *
   * BOTH engine shapes are purged, not just the active engine's: ENGINE_TYPE is a deploy-level
   * switch, so a session that ever ran under both engines leaves a live auth dir for each, and
   * removing only the active engine's would strand the other's WhatsApp credentials on disk after
   * "delete" — able to silently re-link if the engine is ever switched back (and carried into
   * backups). Each rm is isolated best-effort: an unsafe key is refused up front, and one engine's
   * rm failure is logged per-engine — it neither fails the delete nor skips the other engine's purge.
   *
   * Note: session START deliberately does NOT purge the inactive engine's residue. An operator
   * trialling the other engine keeps the previous engine's link so switching back doesn't force a
   * re-pair; the residue is removed only when the session itself is deleted.
   *
   * `legacyName` is the row's name, passed by delete. SessionAuthDirMigration leaves the legacy
   * name-keyed directory in place whenever it could not rename it (an open profile on Windows, or an
   * id-keyed directory already there), so purging only the id-keyed dirs would strand a complete
   * WhatsApp login on the volume and in every backup taken after the delete. It is removed only when
   * the base directory really holds an entry with that exact name; see readAuthDirEntries.
   */
  async purgeSessionData(sessionId: string, legacyName?: string): Promise<void> {
    if (!isSafeSessionName(sessionId)) {
      // Same guard as create(): never let a key with '.', '/' or '\\' reach an rm -rf sink.
      this.logger.warn('Refusing to purge session data for an unsafe session key', {
        action: 'engine_purge_unsafe',
        key: JSON.stringify(sessionId),
      });
      return;
    }
    const dirs: Array<{ engine: string; dir: string }> = [
      { engine: 'whatsapp-web.js', dir: this.wwjsAuthDir(sessionId) },
      { engine: 'baileys', dir: this.baileysAuthDir(sessionId) },
    ];
    if (legacyName !== undefined && isSafeSessionName(legacyName)) {
      const legacyDirs = [
        { engine: 'whatsapp-web.js', dir: this.wwjsAuthDir(legacyName) },
        { engine: 'baileys', dir: this.baileysAuthDir(legacyName) },
      ];
      dirs.push(...legacyDirs.filter(({ dir }) => this.authDirExists(dir)));
    }
    for (const { engine, dir } of dirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        this.logger.log('Purged session auth directory', { action: 'engine_purge', engine, sessionId, dir });
      } catch (error) {
        this.logger.warn('Failed to purge session auth directory', {
          action: 'engine_purge_failed',
          engine,
          sessionId,
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** The whatsapp-web.js LocalAuth profile dir for `sessionId`, with sessionDataPath from config. */
  private wwjsAuthDir(sessionId: string): string {
    return wwjsAuthDir(this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions', sessionId);
  }

  /** The baileys multi-file auth dir for `sessionId`, with authDir from config. */
  private baileysAuthDir(sessionId: string): string {
    return baileysAuthDir(this.configService.get<string>('engine.baileys.authDir') ?? './data/baileys', sessionId);
  }

  /** True when `dir`'s base directory holds an entry with exactly that name (see readAuthDirEntries). */
  private authDirExists(dir: string): boolean {
    try {
      return readAuthDirEntries(path.dirname(dir)).has(path.basename(dir));
    } catch {
      return false; // base directory missing or unreadable: nothing of this shape to purge
    }
  }

  private isEnginePlugin(instance: unknown): instance is IEnginePlugin {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'type' in instance &&
      instance.type === PluginType.ENGINE &&
      'createEngine' in instance &&
      typeof (instance as { createEngine: unknown }).createEngine === 'function'
    );
  }

  private createFallbackEngine(options: EngineCreateOptions): IWhatsAppEngine {
    // This legacy fallback can only construct the whatsapp-web.js adapter. If a different engine was
    // requested (e.g. ENGINE_TYPE=baileys) and its plugin wasn't available, building wwebjs here would
    // silently run the WRONG engine — fail loudly so the misconfiguration is visible instead.
    if (this.engineType !== 'whatsapp-web.js') {
      throw new Error(
        `Engine '${this.engineType}' is unavailable and has no direct fallback; cannot start the session.`,
      );
    }

    // Legacy direct creation (fallback)
    return new WhatsAppWebJsAdapter({
      sessionId: options.sessionId,
      sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
      puppeteer: {
        headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
        args: this.configService.get<string[]>('engine.puppeteer.args') ?? ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: this.configService.get<string>('engine.puppeteer.executablePath'),
        protocolTimeoutMs: this.configService.get<number>('engine.puppeteer.protocolTimeoutMs'),
      },
      proxy: options.proxyUrl
        ? {
            url: options.proxyUrl,
            type: options.proxyType ?? 'http',
          }
        : undefined,
      lidMappingStore: this.lidMappingStore,
    });
  }

  // ============================================================================
  // Query Methods for API/Dashboard
  // ============================================================================

  getAvailableEngines(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    features: string[];
    library?: { name: string; version: string };
  }> {
    const enginePlugins = this.pluginLoader.getPluginsByType(PluginType.ENGINE);

    return enginePlugins.map(plugin => {
      const inst = plugin.instance;
      const features = inst && this.isEnginePlugin(inst) ? inst.getFeatures() : [];
      // The real underlying library version (e.g. whatsapp-web.js 1.34.7), distinct from the
      // plugin's manifest version — so the dashboard can show which engine is actually running.
      const library = inst && this.isEnginePlugin(inst) ? inst.getEngineLibrary?.() : undefined;

      return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        enabled: this.pluginLoader.isPluginEnabled(plugin.manifest.id),
        features,
        library,
      };
    });
  }

  getCurrentEngine(): string {
    return this.engineType;
  }
}
