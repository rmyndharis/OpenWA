import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
// Type-only, on purpose: they keep the port signatures aligned with the real services without
// creating any runtime module edge from core back into a feature module.
import type { MessageResponseDto } from '../../modules/message/dto';
import type { HandoverState } from '../../modules/integration/entities/conversation-mapping.entity';

/**
 * The narrow slices of host feature services that plugin capability code invokes — one port per
 * service, each holding ONLY the members `PluginCapabilityContext` and `PluginSandboxBridge` actually
 * call, plus one for the automation reply path. Deliberately not whole-service mirrors: a reviewer
 * reads here what the plugin runtime can reach, nothing more.
 *
 * The module that owns each service binds it to the port's token with a `useExisting` alias (an
 * alias, not a factory returning the instance: Nest runs lifecycle hooks once per non-alias
 * provider, so a factory doubled the service's hooks). Core resolves the TOKEN at call time via
 * `ModuleRef.get(..., { strict: false })` — never the service class — so the deferral that breaks
 * the plugin provider cycle stays, while core/plugins itself imports no feature-module value and
 * the old lazy `require(...)` of feature-module paths is gone entirely.
 */
export interface PluginMessagePort {
  sendText(
    sessionId: string,
    dto: { chatId: string; text: string; linkPreview?: boolean },
    /**
     * Out-of-band send options; `automated: true` marks the persisted row as bot-written (see
     * `Message.automated`), which is what keeps the automation rules' human-reply gate from
     * mistaking an autoreply for the operator answering. Carried on the port because the automation
     * reply path reaches MessageService only through this token.
     */
    opts?: { automated?: boolean },
  ): Promise<MessageResponseDto>;
  reply(sessionId: string, dto: { chatId: string; quotedMessageId: string; text: string }): Promise<MessageResponseDto>;
  sendImage(sessionId: string, dto: { chatId: string; url?: string; caption?: string }): Promise<MessageResponseDto>;
  sendVideo(sessionId: string, dto: { chatId: string; url?: string; caption?: string }): Promise<MessageResponseDto>;
  sendDocument(sessionId: string, dto: { chatId: string; url?: string; caption?: string }): Promise<MessageResponseDto>;
  sendAudio(
    sessionId: string,
    dto: { chatId: string; url?: string; caption?: string; ptt?: boolean },
  ): Promise<MessageResponseDto>;
  sendLocation(
    sessionId: string,
    dto: { chatId: string; latitude: number; longitude: number; description?: string },
  ): Promise<MessageResponseDto>;
}

/** Live-engine resolution + the deleted-session probe the capability gates rely on. */
export interface PluginSessionPort {
  getEngine(sessionId: string): IWhatsAppEngine | undefined;
  /** Rejects with NotFoundException when the session row no longer exists. */
  findOne(sessionId: string): Promise<unknown>;
}

/** Forward key of a conversation mapping — (session, chat, plugin, provisioned instance). */
export interface PluginMappingKey {
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
}

/** The mapping columns plugin capability code reads. */
export interface PluginConversationMappingRow {
  id: string;
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
  providerConversationId: string;
  handoverState: HandoverState;
}

/** Conversation-mapping verbs: the conversation/handover/mappings capabilities and the hook handover gate. */
export interface PluginConversationMappingPort {
  get(key: PluginMappingKey): Promise<PluginConversationMappingRow | null>;
  getByProvider(
    pluginId: string,
    instanceId: string,
    providerConversationId: string,
  ): Promise<PluginConversationMappingRow | null>;
  upsert(key: PluginMappingKey, providerConversationId: string): Promise<void>;
  delete(id: string): Promise<void>;
  setHandover(id: string, state: HandoverState): Promise<void>;
  rebindSession(id: string, sessionId: string): Promise<void>;
  findHandoverForChat(
    sessionId: string,
    chatId: string,
  ): Promise<{ pluginId: string; handoverState: HandoverState } | null>;
}

/** A provisioned instance of an adapter plugin, as the instance-allowlist and ingress dispatch read it. */
export interface PluginInstanceRecord {
  enabled: boolean;
  config?: Record<string, unknown> | null;
  sessionScope?: string | null;
}

/** Instance lookup verbs: the net-allowlist widening and the ingress per-instance config resolution. */
export interface PluginInstancePort {
  list(pluginId: string): Promise<PluginInstanceRecord[]>;
  resolve(pluginId: string, instanceId: string): Promise<PluginInstanceRecord | null>;
}

/**
 * Search-registry mutations a sandboxed plugin's registration reaches. `register` takes the provider
 * shape the registration util constructs; the registry port is intentionally wider than nothing but
 * narrower than the whole registry (`active`/`list` belong to the search feature's own callers).
 */
export interface PluginSearchRegistryPort {
  register(provider: { id: string }): void;
  unregister(id: string): void;
  setActive(id: string): void;
}

/** Message send/history surface, bound to MessageService by MessageModule. */
export const PLUGIN_MESSAGE_PORT = Symbol('PLUGIN_MESSAGE_PORT');
/** Session engine resolution, bound to SessionService by SessionModule. */
export const PLUGIN_SESSION_PORT = Symbol('PLUGIN_SESSION_PORT');
/** Conversation mapping verbs, bound to ConversationMappingService by PluginsModule (its provider home). */
export const PLUGIN_CONVERSATION_MAPPING_PORT = Symbol('PLUGIN_CONVERSATION_MAPPING_PORT');
/** Provisioned-instance lookup, bound to PluginInstanceService by IntegrationModule. */
export const PLUGIN_INSTANCE_PORT = Symbol('PLUGIN_INSTANCE_PORT');
/** Search-registry mutations, bound to SearchProviderRegistry by SearchModule. */
export const PLUGIN_SEARCH_REGISTRY_PORT = Symbol('PLUGIN_SEARCH_REGISTRY_PORT');
