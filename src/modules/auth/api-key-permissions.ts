import type { ApiKey } from './entities/api-key.entity';

/**
 * What a key may be BLOCKED from doing, independent of its role, session scope and chat scope.
 *
 * The model is a blocklist: a key is allowed everything its role and scopes allow — exactly as
 * before this field existed — and each capability listed in `deniedPermissions` turns its routes
 * off. Authenticated routes without a capability tag fail closed for a restricted key unless they
 * are explicitly capability-agnostic. An empty/absent list therefore leaves the key untouched,
 * which is why every key minted before the field existed keeps working.
 *
 * The role is still checked first: blocking nothing cannot lift a VIEWER key above its role, and
 * blocking `messages:send` on an ADMIN key only removes the send routes.
 */
export enum ApiKeyCapability {
  /** Read stored messages: history, chat history, reactions, receipts, media downloads, batch status, and forwarding one. */
  MESSAGES_READ = 'messages:read',
  /** Send messages: text, media, template, location, contact, sticker, poll, reply, forward, react, bulk, product, typing, presence. */
  MESSAGES_SEND = 'messages:send',
  /** Edit a sent message. */
  MESSAGES_EDIT = 'messages:edit',
  /** Delete a message, or clear a chat's stored messages. */
  MESSAGES_DELETE = 'messages:delete',
  /** Moderate messages: pin, unpin, star, vote in a poll. */
  MESSAGES_MODERATE = 'messages:moderate',
  /** Read the session's chat list and a chat's presence. */
  CHATS_READ = 'chats:read',
  /** Change chat state: mark read/unread, archive, mute, pin, delete a chat. */
  CHATS_MANAGE = 'chats:manage',
  /** Read the contact directory, lookups, profile pictures and the blocked list. */
  CONTACTS_READ = 'contacts:read',
  /** Write contacts: create/update, delete, block, unblock. */
  CONTACTS_WRITE = 'contacts:write',
  /** Read group detail, settings, membership requests and pictures. */
  GROUPS_READ = 'groups:read',
  /** Write groups: create, settings, participants, subject, description, member label, leave, picture, membership requests. */
  GROUPS_MANAGE = 'groups:manage',
  /** Use invite material: join preview, join, read or revoke an invite code. */
  GROUPS_INVITE = 'groups:invite',
  /** Read sessions: list, detail, config, overview statistics. */
  SESSIONS_READ = 'sessions:read',
  /** Create a session. */
  SESSIONS_CREATE = 'sessions:create',
  /** Start, stop, log out, force-kill or delete a session. */
  SESSIONS_LIFECYCLE = 'sessions:lifecycle',
  /** Fetch the QR or request a pairing code — credentials for linking an account. */
  SESSIONS_PAIR = 'sessions:pair',
  /** Change a session's tunable configuration. */
  SESSIONS_CONFIG = 'sessions:config',
  /** Read or change a session's egress proxy. */
  SESSIONS_PROXY = 'sessions:proxy',
  /** Read labels and the labels of a chat. */
  LABELS_READ = 'labels:read',
  /** Create/update/delete labels and assign them to chats. */
  LABELS_WRITE = 'labels:write',
  /** Change the linked account's profile: name, status, picture. */
  PROFILE_WRITE = 'profile:write',
  /** Read the product catalog. */
  CATALOG_READ = 'catalog:read',
  /** Send a product message. */
  CATALOG_SEND = 'catalog:send',
  /** Read message templates. */
  TEMPLATES_READ = 'templates:read',
  /** Create, update or delete message templates. */
  TEMPLATES_WRITE = 'templates:write',
  /** Read webhooks and their delivery failures. */
  WEBHOOKS_READ = 'webhooks:read',
  /** Create, update, test, delete or redrive webhooks. */
  WEBHOOKS_WRITE = 'webhooks:write',
  /** Read automation rules. */
  AUTOMATION_READ = 'automation:read',
  /** Create, update or delete automation rules. */
  AUTOMATION_WRITE = 'automation:write',
  /** Read channels (newsletters) and their messages. */
  CHANNELS_READ = 'channels:read',
  /** Create, delete, mute, moderate or transfer a channel. */
  CHANNELS_WRITE = 'channels:write',
  /** Read statuses. */
  STATUS_READ = 'status:read',
  /** Post a status. */
  STATUS_SEND = 'status:send',
  /** Delete a status. */
  STATUS_DELETE = 'status:delete',
  /** Convert media for sending (voice/video tooling). */
  MEDIA_CONVERT = 'media:convert',
  /** Accept or reject a call link. */
  CALLS_MANAGE = 'calls:manage',
  /** Search stored messages across sessions. */
  SEARCH_READ = 'search:read',
  /** Subscribe to the `/events` WebSocket stream. */
  EVENTS_READ = 'events:read',
  /** Read the audit log. */
  AUDIT_READ = 'audit:read',
  /** Read deployment statistics. */
  STATS_READ = 'stats:read',
  /** Read deployment settings. */
  SETTINGS_READ = 'settings:read',
  /** Read infrastructure status, engines, storage counts, update checks. */
  INFRA_READ = 'infra:read',
  /** Change infrastructure: config, restart, data/storage export and import. */
  INFRA_WRITE = 'infra:write',
  /** Read the plugin catalogue and plugin state. */
  PLUGINS_READ = 'plugins:read',
  /** Install, update, enable/disable, configure or uninstall plugins. */
  PLUGINS_WRITE = 'plugins:write',
  /** Manage integration instances and redrive deliveries. */
  INTEGRATIONS_MANAGE = 'integrations:manage',
  /** Create, update, revoke or delete API keys. */
  APIKEYS_MANAGE = 'apikeys:manage',
}

/** Every capability a key may be blocked from. The DTO publishes this list. */
export const API_KEY_CAPABILITIES: readonly ApiKeyCapability[] = Object.values(ApiKeyCapability);

const KNOWN = new Set<string>(API_KEY_CAPABILITIES);

/**
 * The blocked-capability list a key can be stored with: known capabilities only, trimmed, deduplicated, or NULL.
 *
 * Unknown entries are dropped on write, which the API refuses before this; a read that finds one stored blocks every
 * capability (see hasUnrecognizedDeniedEntry). NULL, not `[]`, for the same reason as the scope columns: `simple-array`
 * reads `''` back as `[]`, and every site treats a zero-length list as "nothing blocked", so an empty list must be
 * stored as the absent field.
 */
export function normalizeDeniedCapabilities(list: readonly string[] | null | undefined): ApiKeyCapability[] | null {
  if (list == null) return null;
  const cleaned: ApiKeyCapability[] = [];
  for (const entry of list) {
    const value = typeof entry === 'string' ? entry.trim() : '';
    if (KNOWN.has(value) && !cleaned.includes(value as ApiKeyCapability)) {
      cleaned.push(value as ApiKeyCapability);
    }
  }
  return cleaned.length > 0 ? cleaned : null;
}

/** The capabilities a stored key is blocked from; empty for a key with nothing blocked. */
export function apiKeyDeniedCapabilities(
  apiKey: Pick<ApiKey, 'deniedPermissions'> | null | undefined,
): ApiKeyCapability[] {
  return normalizeDeniedCapabilities(apiKey?.deniedPermissions) ?? [];
}

/**
 * True when a stored list holds a name this build does not know (a hand edit, or a value another release wrote). What
 * it meant cannot be enforced, so the key is blocked from every capability, as an unreadable expiry reads as expired.
 */
export function hasUnrecognizedDeniedEntry(apiKey: Pick<ApiKey, 'deniedPermissions'> | null | undefined): boolean {
  return (apiKey?.deniedPermissions ?? []).some(entry => {
    const value = typeof entry === 'string' ? entry.trim() : entry;
    return value !== '' && !KNOWN.has(value);
  });
}

/** True when the key blocks at least one capability. */
export function hasBlockedCapabilities(apiKey: Pick<ApiKey, 'deniedPermissions'> | null | undefined): boolean {
  return hasUnrecognizedDeniedEntry(apiKey) || apiKeyDeniedCapabilities(apiKey).length > 0;
}

/** Whether the key is blocked from this capability. Nothing blocked means nothing denied. */
export function isCapabilityDenied(
  apiKey: Pick<ApiKey, 'deniedPermissions'> | null | undefined,
  capability: ApiKeyCapability,
): boolean {
  return hasUnrecognizedDeniedEntry(apiKey) || apiKeyDeniedCapabilities(apiKey).includes(capability);
}

/** Capabilities exposed by one event payload, in addition to the event-stream capability itself. */
export function eventCapabilities(event: string): readonly ApiKeyCapability[] {
  if (event.startsWith('message.') || event === 'poll.vote' || event === 'event.response') {
    return [ApiKeyCapability.MESSAGES_READ];
  }
  if (event === 'session.qr') return [ApiKeyCapability.SESSIONS_PAIR];
  if (event.startsWith('session.')) return [ApiKeyCapability.SESSIONS_READ];
  if (event.startsWith('group.')) return [ApiKeyCapability.GROUPS_READ];
  if (event.startsWith('call.')) return [ApiKeyCapability.CALLS_MANAGE];
  if (event === 'status.received') return [ApiKeyCapability.STATUS_READ];
  if (event === 'presence.update') return [ApiKeyCapability.CHATS_READ];
  return [];
}

/** Whether an event would expose data/actions blocked on this key. */
export function isEventDenied(apiKey: Pick<ApiKey, 'deniedPermissions'> | null | undefined, event: string): boolean {
  return eventCapabilities(event).some(capability => isCapabilityDenied(apiKey, capability));
}
