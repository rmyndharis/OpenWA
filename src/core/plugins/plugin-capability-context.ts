import { NotFoundException } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import type { HookManager, HookEvent } from '../hooks';
import type { LidMappingStore } from '../../engine/identity/lid-mapping-store.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { parseWaId, toNeutralJid } from '../../engine/identity/wa-id';
import { ConversationMappingConflict } from '../../modules/integration/conversation-mapping.service';
import { createLogger, UNPRINTABLE } from '../../common/services/logger.service';
import {
  isAllSessionsScope,
  isPluginActiveForSession,
  resolveInstanceConfig,
  resolvePluginConfig,
  sessionScopeKey,
} from './plugin-activation';
import { effectiveNetAllow, isNetHostAllowed, performPluginFetch } from './plugin-net';
import { buildConversationSendFacade, type ConversationMediaType } from './conversation-send-facade';
import { PluginHostServices } from './plugin-host-services';
import type { PluginInstanceRecord, PluginMessagePort } from './plugin-host-ports';
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
  type PluginStorage,
} from './plugin.interfaces';

/**
 * Translate a normalized conversation media send into the concrete MessageService media method for the
 * envelope's type. Kept pure (no `this`) so the loader binds it directly and it can be unit-tested in
 * isolation. The switch is exhaustive over ConversationMediaType — adding a type without a case is a
 * compile error here rather than a silent runtime fall-through.
 */
export function dispatchConversationMedia(
  svc: Pick<PluginMessagePort, 'sendImage' | 'sendVideo' | 'sendAudio' | 'sendDocument'>,
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

// Plugin code can pass anything to its logger, and reading a value can throw (a Proxy trap, a getter, a toString): what
// cannot be read is written as a marker, never thrown into the plugin.

/** The text of a plugin's log message: what String gives for it (a Symbol included), or the marker. */
const messageText = (message: unknown): string => {
  try {
    return String(message);
  } catch {
    return UNPRINTABLE;
  }
};

/** The trace for a plugin's ctx.logger.error: an Error's message, or the text of whatever else was passed. */
const errorText = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return UNPRINTABLE;
  }
};

/** A prototype that is the root of a chain (Object.prototype of any realm, or none): what a plain record has. */
const isRootPrototype = (prototype: object | null): boolean =>
  prototype === null || Object.getPrototypeOf(prototype) === null;

/**
 * A plugin's log meta as the fields of the line: a plain record as it is, nothing as no fields, else as one field. An
 * object whose prototype cannot be read (a Proxy whose getPrototypeOf trap throws, or a revoked one) is taken as a
 * record, as spreading it took it: the logger copies it by its own properties or writes it as [Unreadable].
 */
const metaFields = (meta: unknown): Record<string, unknown> => {
  if (meta === undefined || meta === null) return {};
  if (typeof meta !== 'object') return { meta };
  try {
    return isRootPrototype(Object.getPrototypeOf(meta) as object | null) ? (meta as Record<string, unknown>) : { meta };
  } catch {
    return meta as Record<string, unknown>;
  }
};

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
/** Host-authoritative dispatch context active on an async call tree (hook session or ingress instance). */
export interface PluginDispatchContext {
  sessionId?: string;
  instanceId?: string;
}

export class PluginCapabilityContext {
  // Carries the firing dispatch's sessionId (and ingress instanceId, when applicable) across hook and
  // sandboxed capability handlers so ctx.config and ctx.net.fetch resolve strictly for that dispatch.
  // Per async call tree, so concurrent dispatches never cross over.
  private readonly hookSession = new AsyncLocalStorage<PluginDispatchContext>();

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
   * Run `fn` inside a host-authoritative dispatch context so capabilities (such as `ctx.net.fetch`)
   * scope their checks to the active hook session or ingress instance.
   */
  runWithDispatchContext<T>(ctx: PluginDispatchContext, fn: () => T): T {
    return this.hookSession.run(ctx, fn);
  }

  /**
   * Enforce a plugin's declared manifest permissions at the capability boundary. A plugin may only
   * use a capability whose permission string it declares in `manifest.permissions`; anything else
   * (including a manifest with no permissions) is denied. Runs first in each capability verb so a
   * missing grant fails fast and uniformly as a PluginCapabilityError.
   *
   * The message names the fix, not just the fault. A denial surfaces mid-run — the capability is
   * checked when the verb is called, not at load — so it reaches the operator as a log line detached
   * from whatever upgrade caused it, and it is the only text about the problem that arrives at the
   * same time as the symptom. Naming `permissions` in the plugin's manifest.json turns "why is this
   * plugin broken" into a one-line edit.
   */
  private assertPermission(manifest: PluginManifest, permission: PluginCapabilityPermission): void {
    if (!(manifest.permissions ?? []).includes(permission)) {
      throw new PluginCapabilityError(
        `Plugin ${manifest.id} is missing the '${permission}' permission required for this capability. ` +
          `Add "${permission}" to the "permissions" array in the plugin's manifest.json, then reload the plugin.`,
      );
    }
  }

  /** Whether `manifest.sessions` permits `sessionId` (absent = ['*']). */
  private isSessionAllowed(manifest: PluginManifest, sessionId: string): boolean {
    const allowed = manifest.sessions ?? ['*'];
    return allowed.includes('*') || allowed.includes(sessionId);
  }

  /**
   * Enforce a plugin's manifest session scope. Runs BEFORE any engine/message resolution -
   * sessionId is supplied by the plugin, so this is the security boundary. Absent = ['*'].
   */
  private assertSessionAllowed(manifest: PluginManifest, sessionId: string): void {
    if (!this.isSessionAllowed(manifest, sessionId)) {
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
    const engine = this.hostServices.getSessionPort().getEngine(sessionId);
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
      await this.hostServices.getSessionPort().findOne(sessionId);
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
          plugin.manifest,
        );
      },
      hookManager: this.hookManager,
      logger: this.buildPluginLogger(plugin),
      storage: this.buildStorageCapability(plugin),
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

  // The plugin id is the host's field, passed apart from the plugin's meta so that a meta the logger cuts keeps it.
  private buildPluginLogger(plugin: PluginInstance): PluginLogger {
    return {
      log: (message, meta) =>
        this.logger.log(`[${plugin.manifest.id}] ${messageText(message)}`, metaFields(meta), {
          pluginId: plugin.manifest.id,
        }),
      debug: (message, meta) =>
        this.logger.debug(`[${plugin.manifest.id}] ${messageText(message)}`, metaFields(meta), {
          pluginId: plugin.manifest.id,
        }),
      warn: (message, meta) =>
        this.logger.warn(`[${plugin.manifest.id}] ${messageText(message)}`, metaFields(meta), {
          pluginId: plugin.manifest.id,
        }),
      error: (message, error, meta) =>
        this.logger.error(
          `[${plugin.manifest.id}] ${messageText(message)}`,
          error === undefined ? undefined : errorText(error),
          metaFields(meta),
          { pluginId: plugin.manifest.id },
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
        return this.hostServices.getMessagePort().sendText(sessionId, { chatId, text });
      },
      reply: async (sessionId, chatId, quotedMessageId, text) => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
        this.resolveEngine(plugin, sessionId);
        return this.hostServices.getMessagePort().reply(sessionId, { chatId, quotedMessageId, text });
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
      getChatHistory: async (sessionId, chatId, limit, includeMedia) => {
        const page = await this.resolveEngineRead(plugin, sessionId).getChatHistory(
          chatId,
          // Clamp to the REST non-deep ceiling (MessageService.MAX_CHAT_HISTORY_LIMIT = 100) so an
          // untrusted plugin can't request an unbounded history fetch. A non-finite limit (a sandboxed
          // caller's arg is unvalidated) takes the default: NaN would reach the engine as "no limit".
          Math.min(Math.max(typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 50, 1), 100),
          includeMedia ?? false,
        );
        // As the REST history does: a deleted message goes by the id of its stored row, the id the plugin
        // was handed when the message arrived. Best effort, and asked only for a page that holds one: a
        // host without the message module still reads history.
        if (page.some(message => message.type === 'revoked')) {
          try {
            await this.hostServices.getMessagePort().nameDeletedByStoredId(sessionId, chatId, page);
          } catch (error) {
            this.logger.warn(
              `[${plugin.manifest.id}] Could not match the deleted messages of a chat history to their stored rows`,
              { sessionId, error: String(error) },
              { pluginId: plugin.manifest.id },
            );
          }
        }
        return page;
      },
      canonicalChatId: async (sessionId, chatId) => {
        this.resolveEngineRead(plugin, sessionId);
        const parsed = parseWaId(chatId);
        const phone =
          parsed.kind === 'lid' ? await this.lidMappingStore?.findPhoneForLid?.(chatId).catch(() => null) : null;
        return toNeutralJid(chatId, () => phone ?? null);
      },
    } satisfies PluginEngineReadCapability;
  }

  /**
   * Per-plugin persistence, behind the permission its manifest must declare. The gate goes on all
   * four verbs rather than on the factory, because the sandbox bridge routes a worker's `storage.*`
   * through this same object — gating only the in-process handle would leave the sandboxed path,
   * the one that actually runs untrusted code, ungated.
   *
   * No session gate: storage is keyed by plugin, not by session, so there is no session to check.
   *
   * Every verb is `async` so a denial arrives as a REJECTION. The backing implementation in
   * PluginStorageService never throws synchronously — an unsafe key and an exceeded quota both come
   * back as a rejected promise — so a synchronous gate would have been the only sync throw on this
   * surface, escaping a plugin that handles failure with `.catch()` alone and taking down the caller
   * instead of failing the capability.
   */
  private buildStorageCapability(plugin: PluginInstance): PluginStorage {
    const storage = this.pluginStorage.createPluginStorage(plugin.manifest.id);
    const gate = (): void => this.assertPermission(plugin.manifest, PluginCapabilityPermission.STORAGE_USE);
    return {
      get: async <T = unknown>(key: string): Promise<T | null> => {
        gate();
        return storage.get<T>(key);
      },
      set: async <T = unknown>(key: string, value: T): Promise<void> => {
        gate();
        return storage.set<T>(key, value);
      },
      delete: async (key: string): Promise<void> => {
        gate();
        return storage.delete(key);
      },
      list: async (prefix?: string): Promise<string[]> => {
        gate();
        return storage.list(prefix);
      },
    } satisfies PluginStorage;
  }

  /** Whether `sessionId` is both manifest-permitted and operator-activated for net host admission. */
  private isSessionActiveForNet(plugin: PluginInstance, sessionId: string): boolean {
    return this.isSessionAllowed(plugin.manifest, sessionId) && this.isHookActive(plugin, sessionId);
  }

  /** Whether an enabled PluginInstance row's scope is currently admissible for `plugin`. */
  private isInstanceRowScopeActive(plugin: PluginInstance, row: Pick<PluginInstanceRecord, 'sessionScope'>): boolean {
    if (isAllSessionsScope(row.sessionScope)) return true;
    if (plugin.manifest.sessionScoped === false) return false;
    return this.isSessionActiveForNet(plugin, row.sessionScope as string);
  }

  /**
   * Enabled instances of a plugin, for the outbound-host allowlist. A disabled instance is not a
   * tenant the operator is running, so its host is never admitted.
   *
   * Best-effort: a plugin may be loaded in a host that exposes no instance service (and the store
   * can fail), and neither is a reason to refuse a fetch the base config already allows.
   */
  private async enabledInstanceRows(pluginId: string): Promise<{ rows: PluginInstanceRecord[]; listed: boolean }> {
    try {
      const rows = await this.hostServices.getPluginInstancePort().list(pluginId);
      return { rows: rows.filter(row => row.enabled), listed: true };
    } catch {
      return { rows: [], listed: false };
    }
  }

  /** Look up one specific enabled instance for an ingress dispatch. */
  private async resolveEnabledInstance(
    pluginId: string,
    instanceId: string,
    listedRows: PluginInstanceRecord[],
  ): Promise<PluginInstanceRecord | null> {
    try {
      const port = this.hostServices.getPluginInstancePort();
      if (typeof port.resolve === 'function') {
        const row = await port.resolve(pluginId, instanceId);
        return row?.enabled ? row : null;
      }
      const found = listedRows.find(
        row => (row as PluginInstanceRecord & { instanceId?: string }).instanceId === instanceId,
      );
      return found ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Layer 1 (outside active hook/ingress dispatch): collect configs admitted for background or
   * lifecycle fetches. Global plugins ignore sessionConfig and concrete-scoped instances; session-
   * scoped plugins admit only active, manifest-permitted session slices and enabled wildcard or
   * active-session instances.
   */
  private collectLayer1NetConfigs(
    plugin: PluginInstance,
    scoped: boolean,
    rows: PluginInstanceRecord[],
    out: Record<string, unknown>[],
  ): void {
    out.push(plugin.config ?? {});
    if (scoped) {
      for (const [sid, cfg] of Object.entries(plugin.sessionConfig ?? {})) {
        if (this.isSessionActiveForNet(plugin, sid)) out.push(cfg);
      }
    }
    for (const row of rows) {
      if (this.isInstanceRowScopeActive(plugin, row)) out.push(row.config ?? {});
    }
  }

  private buildNetCapability(plugin: PluginInstance): PluginNetCapability {
    return {
      fetch: async (url, init) => {
        // Two gates: the declared permission, then a two-layer per-session host allowlist.
        // Layer 2 (inside an active hook or ingress dispatch): scope config-derived hosts strictly
        // to the firing session or ingress instance. Layer 1 (outside dispatch, e.g. onEnable or
        // healthCheck): admit base config plus active, manifest-permitted sessions and enabled
        // wildcard/active-session instances. The SSRF guard inside performPluginFetch still blocks
        // internal IPs even when the host is allowlisted.
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.NET_FETCH);
        const scoped = plugin.manifest.sessionScoped !== false;
        const store = this.hookSession.getStore();
        const { rows, listed } = await this.enabledInstanceRows(plugin.manifest.id);
        const netConfigs: Record<string, unknown>[] = [];

        if (store?.instanceId) {
          const sid = store.sessionId;
          const hasConcreteSession = sid !== undefined && !isAllSessionsScope(sid);
          const sessionActive = hasConcreteSession ? this.isSessionActiveForNet(plugin, sid) : true;
          const match = await this.resolveEnabledInstance(plugin.manifest.id, store.instanceId, rows);
          const matchValid =
            match !== null &&
            this.isInstanceRowScopeActive(plugin, match) &&
            sessionScopeKey(match.sessionScope) === sessionScopeKey(sid);
          if (sessionActive && matchValid) {
            const scopeIsAttributable =
              !hasConcreteSession || (listed && rows.filter(row => row.sessionScope === sid).length <= 1);
            const resolvedBase =
              hasConcreteSession && scopeIsAttributable
                ? resolvePluginConfig(plugin.config ?? {}, plugin.sessionConfig, sid, scoped, plugin.manifest)
                : (plugin.config ?? {});
            netConfigs.push(resolveInstanceConfig(resolvedBase, match.config, plugin.manifest, plugin.config));
          }
        } else if (store?.sessionId) {
          const sid = store.sessionId;
          if (isAllSessionsScope(sid)) {
            this.collectLayer1NetConfigs(plugin, scoped, rows, netConfigs);
          } else if (this.isSessionActiveForNet(plugin, sid)) {
            netConfigs.push(
              resolvePluginConfig(plugin.config ?? {}, plugin.sessionConfig, sid, scoped, plugin.manifest),
            );
            for (const row of rows) {
              if (isAllSessionsScope(row.sessionScope) || (scoped && row.sessionScope === sid)) {
                netConfigs.push(row.config ?? {});
              }
            }
          }
        } else {
          this.collectLayer1NetConfigs(plugin, scoped, rows, netConfigs);
        }

        const allow = [
          ...new Set([
            ...(plugin.manifest.net?.allow ?? []),
            ...netConfigs.flatMap(cfg => effectiveNetAllow(undefined, plugin.manifest.net?.allowConfigHosts, cfg)),
          ]),
        ];
        if (!isNetHostAllowed(allow, url)) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id} may not fetch ${url} - add its host to net.allow or net.allowConfigHosts`,
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
          .getConversationMappingPort()
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
            await this.hostServices.getConversationMappingPort().rebindSession(mapping.id, env.sessionId);
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
      // Re-establish the in-flight hook context around the downstream send, so a conversation.send made
      // from a hook handler cannot re-fire that handler's own event (an echo loop through
      // message:sending). Gate on an ALREADY-in-flight event (mirrors the worker-cap wrap's
      // `inFlight.length > 0` check): a send from an ingress handler or any other top-level context
      // carries none, and must NOT suppress message:sending for observers (audit/moderation, or the
      // adapter's own mirror hook), which then see the reply.
      runGuarded: (events, run) =>
        (events as HookEvent[]).some(e => this.hookManager.isInFlight(e))
          ? this.hookManager.runInFlight(events as HookEvent[], run)
          : run(),
      sendText: (sessionId, opts) => this.hostServices.getMessagePort().sendText(sessionId, opts),
      reply: (sessionId, opts) => this.hostServices.getMessagePort().reply(sessionId, opts),
      sendMedia: (sessionId, opts) => dispatchConversationMedia(this.hostServices.getMessagePort(), sessionId, opts),
      sendLocation: (sessionId, opts) => this.hostServices.getMessagePort().sendLocation(sessionId, opts),
    } satisfies Parameters<typeof buildConversationSendFacade>[0]) satisfies PluginConversationsCapability;
  }

  private buildHandoverCapability(plugin: PluginInstance): PluginHandoverCapability {
    return {
      set: async (key, state) => {
        // Same gate as conversation.send: flipping handover is part of owning the conversation, so
        // it reuses CONVERSATION_SEND rather than adding a new permission.
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        this.assertSessionActive(plugin, key.sessionId);
        // The sandbox router checks this too; an in-process plain-JS plugin reaches here unchecked,
        // and any other value would be stored and silently never hold the chat.
        if (state !== 'bot' && state !== 'human' && state !== 'closed') {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: handover state must be 'bot', 'human' or 'closed'`,
          );
        }
        const mapping = await this.hostServices.getConversationMappingPort().get({
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
        await this.hostServices.getConversationMappingPort().setHandover(mapping.id, state);
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
          await this.hostServices.getConversationMappingPort().upsert(mappingKey, providerConversationId);
        } catch (error) {
          if (!(error instanceof ConversationMappingConflict)) throw error;
          // The reverse unique key is held by another row. If that row's session was DELETED
          // (operator re-paired under a new id), the adapter can never converge — the forward key
          // carries the new sessionId, so every upsert bricks on the dead session's row. Supersede
          // the stale row and retry once. A row owned by an EXISTING session is a genuine conflict
          // and rethrows.
          const stale = await this.hostServices
            .getConversationMappingPort()
            .getByProvider(plugin.manifest.id, key.instanceId, providerConversationId);
          if (!stale || !(await this.isSessionGone(stale.sessionId))) throw error;
          await this.hostServices.getConversationMappingPort().delete(stale.id);
          await this.hostServices.getConversationMappingPort().upsert(mappingKey, providerConversationId);
        }
      },
      get: async key => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        this.assertSessionActive(plugin, key.sessionId);
        const m = await this.hostServices.getConversationMappingPort().get({
          sessionId: key.sessionId,
          chatId: key.chatId,
          pluginId: plugin.manifest.id,
          instanceId: key.instanceId,
        });
        if (!m) return null;
        // The handover the instance holds for the chat, not this row's alone: see effectiveHandover.
        const handoverState = await this.hostServices.getConversationMappingPort().effectiveHandover(m);
        return { providerConversationId: m.providerConversationId, handoverState };
      },
      getByProvider: async (instanceId, providerConversationId) => {
        this.assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        const m = await this.hostServices
          .getConversationMappingPort()
          .getByProvider(plugin.manifest.id, instanceId, providerConversationId);
        // Parity with get/upsert: a plugin may only read a mapping for a session it is activated for.
        if (!m) return null;
        this.assertSessionActive(plugin, m.sessionId);
        const handoverState = await this.hostServices.getConversationMappingPort().effectiveHandover(m);
        return { sessionId: m.sessionId, chatId: m.chatId, handoverState };
      },
    } satisfies PluginMappingsCapability;
  }

  // ============================================================================
  // Query Methods
  // ============================================================================
}
