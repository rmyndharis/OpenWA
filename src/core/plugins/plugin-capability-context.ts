import { NotFoundException } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import type { HookManager, HookEvent } from '../hooks';
import type { LidMappingStore } from '../../engine/identity/lid-mapping-store.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { toNeutralJid, userPart } from '../../engine/identity/wa-id';
import { ConversationMappingConflict } from '../../modules/integration/conversation-mapping.service';
import { createLogger } from '../../common/services/logger.service';
import type { MessageService } from '../../modules/message/message.service';
import { isPluginActiveForSession, resolvePluginConfig } from './plugin-activation';
import { effectiveNetAllow, isNetHostAllowed, performPluginFetch } from './plugin-net';
import { buildConversationSendFacade, type ConversationMediaType } from './conversation-send-facade';
import { PluginHostServices } from './plugin-host-services';
import { PluginStorageService } from './plugin-storage.service';
import {
  PluginCapabilityError,
  PluginCapabilityPermission,
  type PluginContext,
  type PluginConversationsCapability,
  type PluginEngineReadCapability,
  type PluginHandoverCapability,
  type PluginInstance,
  type PluginLogger,
  type PluginManifest,
  type PluginMappingsCapability,
  type PluginMessagingCapability,
  type PluginNetCapability,
} from './plugin.interfaces';

/**
 * Translate a normalized conversation media send into the concrete MessageService media method for the
 * envelope's type. Kept pure (no `this`) so the loader binds it directly and it can be unit-tested in
 * isolation. The switch is exhaustive over ConversationMediaType — adding a type without a case is a
 * compile error here rather than a silent runtime fall-through.
 */
export function dispatchConversationMedia(
  svc: Pick<MessageService, 'sendImage' | 'sendVideo' | 'sendAudio' | 'sendDocument'>,
  sessionId: string,
  opts: { chatId: string; url: string; type: ConversationMediaType; caption?: string },
): Promise<unknown> {
  const dto = { chatId: opts.chatId, url: opts.url, caption: opts.caption };
  switch (opts.type) {
    case 'image':
      return svc.sendImage(sessionId, dto);
    case 'video':
      return svc.sendVideo(sessionId, dto);
    case 'audio':
      return svc.sendAudio(sessionId, dto);
    case 'voice':
      // A voice envelope is a PTT note: sendAudio with ptt classifies it as 'voice' and defaults the
      // codec to audio/ogg;opus, so it renders as a WhatsApp voice bubble rather than an audio file.
      return svc.sendAudio(sessionId, { ...dto, ptt: true });
    case 'file':
      return svc.sendDocument(sessionId, dto);
  }
}

/**
 * The capability surface a plugin actually touches: ctx.messages, ctx.engine, ctx.net, ctx.storage,
 * ctx.conversations, ctx.handover, ctx.mappings — and the gates in front of every one of them.
 *
 * This is the security-review surface. A plugin supplies its own sessionId, so `assertSessionAllowed`
 * (the static manifest boundary) and the operator-activation check are the boundary, not a
 * convenience. Keeping them beside the verbs they guard means a reviewer reads one file rather than
 * tracing gates through a loader that is otherwise about discovery, lifecycle and worker plumbing.
 *
 * It holds no plugin registry and no worker hosts: the loader owns those. Everything here is derived
 * from the PluginInstance passed in.
 */
export class PluginCapabilityContext {
  // Carries the firing event's sessionId across an in-process hook handler so ctx.config (a getter)
  // resolves the per-session slice. Per async call tree, so concurrent sessions don't cross over.
  private readonly hookSession = new AsyncLocalStorage<{ sessionId?: string }>();

  constructor(
    // The LOADER's logger, deliberately — a plugin's ctx.logger lines are prefixed with it, and that
    // context is operator-visible. Creating a second logger here would silently retag every plugin
    // log line the moment this moved out.
    private readonly logger: ReturnType<typeof createLogger>,
    private readonly hostServices: PluginHostServices,
    private readonly hookManager: HookManager,
    private readonly pluginStorage: PluginStorageService,
    private readonly lidMappingStore?: LidMappingStore,
  ) {}

  /**
   * Enforce a plugin's declared manifest permissions at the capability boundary. A plugin may only
   * use a capability whose permission string it declares in `manifest.permissions`; anything else
   * (including a manifest with no permissions) is denied. Runs first in each capability verb so a
   * missing grant fails fast and uniformly as a PluginCapabilityError.
   */
  private assertPermission(manifest: PluginManifest, permission: PluginCapabilityPermission): void {
    if (!(manifest.permissions ?? []).includes(permission)) {
      throw new PluginCapabilityError(
        `Plugin ${manifest.id} is missing the '${permission}' permission required for this capability`,
      );
    }
  }

  /**
   * Enforce a plugin's manifest session scope. Runs BEFORE any engine/message resolution —
   * sessionId is supplied by the plugin, so this is the security boundary. Absent = ['*'].
   */
  private assertSessionAllowed(manifest: PluginManifest, sessionId: string): void {
    const allowed = manifest.sessions ?? ['*'];
    if (!allowed.includes('*') && !allowed.includes(sessionId)) {
      throw new PluginCapabilityError(`Plugin ${manifest.id} is not permitted to act on session ${sessionId}`);
    }
  }

  /** Per-session activation gate: is this plugin currently activated for `sessionId`'s event? */
  private isHookActive(plugin: PluginInstance, sessionId: string | undefined): boolean {
    return isPluginActiveForSession(plugin.manifest.sessionScoped ?? true, plugin.activeSessions ?? ['*'], sessionId);
  }

  /**
   * The capability session gate. A plugin may act on `sessionId` only if BOTH hold: its manifest scope
   * allows the session (the static author boundary, assertSessionAllowed) AND the operator has activated
   * the plugin for that session (the dynamic boundary, the same gate hook dispatch uses). manifest.sessions
   * alone is not enough — a general adapter ships `['*']` and is scoped by operator activation, so without
   * the activeSessions check a plugin activated for one session could reach another's engine/mappings/
   * handover. Defaults (`activeSessions ?? ['*']`, `sessionScoped:false`) preserve every unrestricted flow.
   */
  private assertSessionActive(plugin: PluginInstance, sessionId: string): void {
    this.assertSessionAllowed(plugin.manifest, sessionId);
    if (!this.isHookActive(plugin, sessionId)) {
      throw new PluginCapabilityError(`Plugin ${plugin.manifest.id} is not activated for session ${sessionId}`);
    }
  }

  /**
   * Scope-check, then resolve the live engine for a session. getEngine returns undefined for an
   * unknown OR unstarted session (no throw), so guard it into a defined PluginCapabilityError.
   * A present-but-not-READY engine throws EngineNotReadyError from the adapter on use (→ 409).
   */
  private resolveEngine(plugin: PluginInstance, sessionId: string): IWhatsAppEngine {
    this.assertSessionActive(plugin, sessionId);
    const engine = this.hostServices.getSessionService().getEngine(sessionId);
    if (!engine) {
      throw new PluginCapabilityError(`Session ${sessionId} has no active engine (unknown or not started)`);
    }
    return engine;
  }

  /** Engine read capabilities: require the `engine:read` permission, then resolve the live engine. */
  private resolveEngineRead(plugin: PluginInstance, sessionId: string): IWhatsAppEngine {
    this.assertPermission(plugin.manifest, PluginCapabilityPermission.ENGINE_READ);
    return this.resolveEngine(plugin, sessionId);
  }

  /**
   * Definitive "this session row no longer exists" probe for the stale-mapping repair paths below.
   * True ONLY on a clean not-found from the sessions table; any other failure (service unresolvable,
   * DB error) returns false, so the cross-session fences stay fail-CLOSED when the answer is
   * indeterminate. The runtime engine map can't answer this — a stopped session has no engine but
   * still owns its mappings.
   */
  private async isSessionGone(sessionId: string): Promise<boolean> {
    try {
      await this.hostServices.getSessionService().findOne(sessionId);
      return false;
    } catch (error) {
      return error instanceof NotFoundException;
    }
  }
  createPluginContext(plugin: PluginInstance): PluginContext {
    const hookSession = this.hookSession;
    return {
      pluginId: plugin.manifest.id,
      manifest: plugin.manifest,
      // Per-session: inside a hook, returns the override merged over the base for the firing session;
      // outside a hook (lifecycle), the base config. A getter so it reflects live config edits too.
      get config() {
        return resolvePluginConfig(
          plugin.config,
          plugin.sessionConfig,
          hookSession.getStore()?.sessionId,
          plugin.manifest.sessionScoped !== false,
        );
      },
      hookManager: this.hookManager,
      logger: this.buildPluginLogger(plugin),
      storage: this.pluginStorage.createPluginStorage(plugin.manifest.id),
      registerHook: (event, handler, priority) => {
        // Wrap with the per-session activation gate so an in-process plugin only handles events for
        // the sessions it is activated for (mirrors the sandboxed shim), and scope the firing
        // sessionId so ctx.config resolves the right per-session slice for the handler.
        this.hookManager.register(
          plugin.manifest.id,
          event,
          async hookCtx => {
            if (!this.isHookActive(plugin, hookCtx.sessionId)) return { continue: true };
            return this.hookSession.run({ sessionId: hookCtx.sessionId }, () => handler(hookCtx));
          },
          priority,
        );
      },
      // In-process built-ins are not reached by the ingress pipeline (it dispatches to sandbox hosts),
      // so fail loud rather than silently never firing. Sandboxed plugins get a real registerWebhook
      // from the worker bootstrap.
      registerWebhook: () => {
        throw new PluginCapabilityError(
          `Plugin ${plugin.manifest.id}: registerWebhook (ingress) is only available to sandboxed plugins`,
        );
      },
      messages: this.buildMessagesCapability(plugin),
      engine: this.buildEngineReadCapability(plugin),
      net: this.buildNetCapability(plugin),
      conversations: this.buildConversationsCapability(plugin),
      handover: this.buildHandoverCapability(plugin),
      mappings: this.buildMappingsCapability(plugin),
    };
  }

  private buildPluginLogger(plugin: PluginInstance): PluginLogger {
    return {
      log: (message, meta) =>
        this.logger.log(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
      debug: (message, meta) =>
        this.logger.debug(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
      warn: (message, meta) =>
        this.logger.warn(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
      error: (message, error, meta) =>
        this.logger.error(
          `[${plugin.manifest.id}] ${message}`,
          error instanceof Error ? error.message : String(error),
          { ...meta, pluginId: plugin.manifest.id },
        ),
    };
  }

  private buildMessagesCapability(plugin: PluginInstance): PluginMessagingCapability {
    return {
      sendText: async (sessionId, chatId, text) => {
        // Validate permission + scope + that the session has a live engine BEFORE MessageService
        // persists a pending row: a missing grant / dead session must fail with
        // PluginCapabilityError, not a raw TypeError + orphaned row. resolveEngine also runs
        // assertSessionActive.
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
        this.resolveEngine(plugin, sessionId);
        return this.hostServices.getMessageService().sendText(sessionId, { chatId, text });
      },
      reply: async (sessionId, chatId, quotedMessageId, text) => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
        this.resolveEngine(plugin, sessionId);
        return this.hostServices.getMessageService().reply(sessionId, { chatId, quotedMessageId, text });
      },
    } satisfies PluginMessagingCapability;
  }

  private buildEngineReadCapability(plugin: PluginInstance): PluginEngineReadCapability {
    return {
      getGroupInfo: async (sessionId, groupId) => this.resolveEngineRead(plugin, sessionId).getGroupInfo(groupId),
      getContacts: async sessionId => this.resolveEngineRead(plugin, sessionId).getContacts(),
      getContactById: async (sessionId, contactId) =>
        this.resolveEngineRead(plugin, sessionId).getContactById(contactId),
      checkNumberExists: async (sessionId, phone) => this.resolveEngineRead(plugin, sessionId).checkNumberExists(phone),
      getChats: async sessionId => this.resolveEngineRead(plugin, sessionId).getChats(),
      getChatHistory: async (sessionId, chatId, limit, includeMedia) =>
        this.resolveEngineRead(plugin, sessionId).getChatHistory(
          chatId,
          // Clamp to the REST non-deep ceiling (MessageService.MAX_CHAT_HISTORY_LIMIT = 100) so an
          // untrusted plugin can't request an unbounded history fetch.
          Math.min(Math.max(Math.trunc(limit ?? 50), 1), 100),
          includeMedia ?? false,
        ),
      canonicalChatId: (sessionId, chatId) => {
        // resolveEngineRead is the gate only (engine:read permission + live session); the resolution
        // itself is a synchronous host lid->phone lookup, not an engine call, mirroring the webhook
        // from-filter. Not `async` (nothing to await) — a resolved promise satisfies the signature.
        this.resolveEngineRead(plugin, sessionId);
        return Promise.resolve(toNeutralJid(chatId, jid => this.lidMappingStore?.getCached(userPart(jid)) ?? null));
      },
    } satisfies PluginEngineReadCapability;
  }

  private buildNetCapability(plugin: PluginInstance): PluginNetCapability {
    return {
      fetch: async (url, init) => {
        // Two gates: the declared permission, then the effective host allowlist = manifest net.allow
        // UNION the hosts of net.allowConfigHosts keys across the base config AND every per-session
        // override. The host gate has no firing-session context for a sandboxed plugin's cap round-trip,
        // so admit every operator-configured tenant host (all public + still SSRF-guarded at connect)
        // rather than resolving a single, possibly wrong (base-only), one. The SSRF guard inside
        // performPluginFetch still blocks internal IPs even when the host is allowlisted.
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.NET_FETCH);
        const netConfigs = [plugin.config ?? {}, ...Object.values(plugin.sessionConfig ?? {})];
        const allow = [
          ...new Set(
            netConfigs.flatMap(cfg =>
              effectiveNetAllow(plugin.manifest.net?.allow, plugin.manifest.net?.allowConfigHosts, cfg),
            ),
          ),
        ];
        if (!isNetHostAllowed(allow, url)) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id} may not fetch ${url} — add its host to net.allow or net.allowConfigHosts`,
          );
        }
        return performPluginFetch(url, init);
      },
    } satisfies PluginNetCapability;
  }

  private buildConversationsCapability(plugin: PluginInstance): PluginConversationsCapability {
    return buildConversationSendFacade({
      manifest: plugin.manifest,
      assertPermission: this.assertPermission.bind(this),
      assertSessionActive: (sessionId: string) => this.assertSessionActive(plugin, sessionId),
      resolveChatId: async env => {
        if (!env.instanceId || !env.source?.externalConversationId) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: conversation.send requires chatId, or both instanceId and source to resolve one`,
          );
        }
        const mapping = await this.hostServices
          .getConversationMappingService()
          .getByProvider(plugin.manifest.id, env.instanceId, env.source.externalConversationId);
        if (!mapping) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: no conversation mapping for instance ${env.instanceId} / ${env.source.externalConversationId}`,
          );
        }
        // Fail closed on a cross-session mapping: getByProvider keys on (pluginId, instanceId,
        // providerConversationId) only, so a stale row can resolve to a chat owned by a DIFFERENT
        // session than the envelope's. Parity with the assertSessionActive(m.sessionId) check on
        // mappings.getByProvider below — never send through a session the mapping does not belong to.
        // (mapping.sessionId is NOT NULL in the entity, so a plain inequality check suffices. The
        // env.sessionId guard is for the type only — the facade rejects a missing sessionId first.)
        if (env.sessionId && mapping.sessionId !== env.sessionId) {
          // Repair path: the mapping's session was DELETED (operator re-paired under a new id), so
          // the row is stale rather than cross-session. Rebind it to the envelope's session —
          // already activation-gated by the facade — and let the send proceed; without this the
          // dead session's rows bricked conversation.send permanently. A mapping owned by another
          // EXISTING session is a genuine cross-session violation and still throws.
          if (await this.isSessionGone(mapping.sessionId)) {
            await this.hostServices.getConversationMappingService().rebindSession(mapping.id, env.sessionId);
            this.logger.warn(
              `Rebound conversation mapping for instance ${env.instanceId} / ${env.source.externalConversationId} ` +
                `from deleted session ${mapping.sessionId} to ${env.sessionId}`,
              { pluginId: plugin.manifest.id, action: 'conversation_mapping_rebound' },
            );
            return mapping.chatId;
          }
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: conversation mapping for instance ${env.instanceId} / ${env.source.externalConversationId} belongs to session ${mapping.sessionId}, not ${env.sessionId}`,
          );
        }
        return mapping.chatId;
      },
      // Re-establish the in-flight hook context around the downstream send so an adapter that calls
      // conversation.send from within its own ingress handling can't echo-loop back into itself via
      // its own outbound message:sending hook. Gate on an ALREADY-in-flight event (mirrors the
      // worker-cap wrap's `inFlight.length > 0` check): a plain top-level send must NOT suppress
      // message:sending for unrelated observers (audit/moderation) — only genuine re-entrancy does.
      runGuarded: (events, run) =>
        (events as HookEvent[]).some(e => this.hookManager.isInFlight(e))
          ? this.hookManager.runInFlight(events as HookEvent[], run)
          : run(),
      sendText: (sessionId, opts) => this.hostServices.getMessageService().sendText(sessionId, opts),
      reply: (sessionId, opts) => this.hostServices.getMessageService().reply(sessionId, opts),
      sendMedia: (sessionId, opts) => dispatchConversationMedia(this.hostServices.getMessageService(), sessionId, opts),
      sendLocation: (sessionId, opts) => this.hostServices.getMessageService().sendLocation(sessionId, opts),
    } satisfies Parameters<typeof buildConversationSendFacade>[0]) satisfies PluginConversationsCapability;
  }

  private buildHandoverCapability(plugin: PluginInstance): PluginHandoverCapability {
    return {
      set: async (key, state) => {
        // Same gate as conversation.send: flipping handover is part of owning the conversation, so
        // it reuses CONVERSATION_SEND rather than adding a new permission.
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        this.assertSessionActive(plugin, key.sessionId);
        const mapping = await this.hostServices.getConversationMappingService().get({
          sessionId: key.sessionId,
          chatId: key.chatId,
          pluginId: plugin.manifest.id,
          instanceId: key.instanceId,
        });
        if (!mapping) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: no conversation mapping for session ${key.sessionId} / chat ${key.chatId} / instance ${key.instanceId}`,
          );
        }
        await this.hostServices.getConversationMappingService().setHandover(mapping.id, state);
      },
    } satisfies PluginHandoverCapability;
  }

  private buildMappingsCapability(plugin: PluginInstance): PluginMappingsCapability {
    return {
      upsert: async (key, providerConversationId) => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        this.assertSessionActive(plugin, key.sessionId);
        const mappingKey = {
          sessionId: key.sessionId,
          chatId: key.chatId,
          pluginId: plugin.manifest.id,
          instanceId: key.instanceId,
        };
        try {
          await this.hostServices.getConversationMappingService().upsert(mappingKey, providerConversationId);
        } catch (error) {
          if (!(error instanceof ConversationMappingConflict)) throw error;
          // The reverse unique key is held by another row. If that row's session was DELETED
          // (operator re-paired under a new id), the adapter can never converge — the forward key
          // carries the new sessionId, so every upsert bricks on the dead session's row. Supersede
          // the stale row and retry once. A row owned by an EXISTING session is a genuine conflict
          // and rethrows.
          const stale = await this.hostServices
            .getConversationMappingService()
            .getByProvider(plugin.manifest.id, key.instanceId, providerConversationId);
          if (!stale || !(await this.isSessionGone(stale.sessionId))) throw error;
          await this.hostServices.getConversationMappingService().delete(stale.id);
          await this.hostServices.getConversationMappingService().upsert(mappingKey, providerConversationId);
        }
      },
      get: async key => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        this.assertSessionActive(plugin, key.sessionId);
        const m = await this.hostServices.getConversationMappingService().get({
          sessionId: key.sessionId,
          chatId: key.chatId,
          pluginId: plugin.manifest.id,
          instanceId: key.instanceId,
        });
        return m ? { providerConversationId: m.providerConversationId, handoverState: m.handoverState } : null;
      },
      getByProvider: async (instanceId, providerConversationId) => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        const m = await this.hostServices
          .getConversationMappingService()
          .getByProvider(plugin.manifest.id, instanceId, providerConversationId);
        // Parity with get/upsert: a plugin may only read a mapping for a session it is activated for.
        if (m) this.assertSessionActive(plugin, m.sessionId);
        return m ? { sessionId: m.sessionId, chatId: m.chatId, handoverState: m.handoverState } : null;
      },
    } satisfies PluginMappingsCapability;
  }

  // ============================================================================
  // Query Methods
  // ============================================================================
}
