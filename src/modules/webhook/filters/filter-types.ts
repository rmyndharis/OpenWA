/**
 * Smart webhook filters: an optional, additive pre-filter layer applied to webhook
 * triggers. A webhook with no filters behaves exactly as before. When filters are
 * present, every condition must match (logical AND) for the webhook to fire.
 *
 * The design is intentionally event-family aware so it can grow beyond messages:
 * fields are registered per family (`message`, later `session`/`group`). A condition
 * whose field is unknown for the fired event's family is skipped, so a webhook
 * subscribed to several families behaves sanely without per-event filter sets.
 */

import { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { chatKind, type ChatKind } from '../../../engine/identity/wa-id';

export type FilterOperator = 'is' | 'isNot' | 'contains' | 'equals';

/** Value shape a field resolves to, which decides how operators are applied. */
export type FieldKind = 'id' | 'idArray' | 'text' | 'enum' | 'boolean';

export interface WebhookFilterCondition {
  field: string;
  operator: FilterOperator;
  value: string | string[] | boolean;
  /** Only meaningful for `text` fields (`contains`/`equals`). Defaults to false. */
  caseSensitive?: boolean;
}

export interface WebhookFilters {
  conditions: WebhookFilterCondition[];
}

export interface FieldDefinition {
  field: string;
  kind: FieldKind;
  operators: FilterOperator[];
  resolve: (data: Record<string, unknown>) => unknown;
  /** Allowed values for `enum` fields (used by validation + dashboard). */
  enumValues?: readonly string[];
}

/**
 * Every neutral message type a `type` filter condition may name. Derived exhaustively from the
 * engine-neutral {@link MessageType} union so a type added there cannot be silently rejected here:
 * `poll` was offered by the dashboard's own copy of this list while saving was refused as invalid.
 * The `Record<MessageType, ...>` shape makes an omitted or stale entry a compile error.
 */
const MESSAGE_TYPE_FLAGS: Record<MessageType, true> = {
  text: true,
  image: true,
  video: true,
  audio: true,
  voice: true,
  document: true,
  sticker: true,
  location: true,
  contact: true,
  poll: true,
  call: true,
  revoked: true,
  order: true,
  product: true,
  masked: true,
  unknown: true,
};

export const MESSAGE_TYPES: readonly MessageType[] = Object.keys(MESSAGE_TYPE_FLAGS) as MessageType[];

/** Chat kinds a message-family filter can match on. `channel` is a newsletter; see chatKind(). */
export const CHAT_KINDS: readonly ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

// Guard rails. These bound both stored config size and per-event evaluation cost.
export const MAX_CONDITIONS = 20;
export const MAX_VALUES_PER_CONDITION = 100;
export const MAX_TEXT_VALUE_LENGTH = 1000;

const ID_OPERATORS: FilterOperator[] = ['is', 'isNot'];
const TEXT_OPERATORS: FilterOperator[] = ['contains', 'equals'];
const ENUM_OPERATORS: FilterOperator[] = ['is', 'isNot'];
const BOOLEAN_OPERATORS: FilterOperator[] = ['is'];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Field registry keyed by event family. v1 ships `message`; `session`/`group`
 * slot in later by adding entries here, with no change to the evaluator.
 */
export const FILTER_FIELDS: Record<string, FieldDefinition[]> = {
  message: [
    {
      field: 'sender',
      kind: 'id',
      operators: ID_OPERATORS,
      // In groups `from` is the group JID; `author` is the real participant.
      resolve: data => str(data.author) ?? str(data.from),
    },
    {
      field: 'recipient',
      kind: 'id',
      operators: ID_OPERATORS,
      resolve: data => str(data.to),
    },
    {
      field: 'body',
      kind: 'text',
      operators: TEXT_OPERATORS,
      resolve: data => str(data.body) ?? '',
    },
    {
      field: 'type',
      kind: 'enum',
      operators: ENUM_OPERATORS,
      enumValues: MESSAGE_TYPES,
      resolve: data => str(data.type),
    },
    {
      field: 'isGroup',
      kind: 'boolean',
      operators: BOOLEAN_OPERATORS,
      resolve: data => data.isGroup === true,
    },
    {
      // The chat kind, so a filter can single out or exclude a channel (newsletter) where the
      // boolean isGroup cannot: individual, group, channel, status, broadcast and unknown all
      // collapse to isGroup=false. `kind` rides the received payload directly; the edited, reaction
      // and revoked events in this family carry only chatId, so derive it there.
      field: 'kind',
      kind: 'enum',
      operators: ENUM_OPERATORS,
      enumValues: CHAT_KINDS,
      resolve: data => {
        const k = str(data.kind);
        if (k) return k;
        const chatId = str(data.chatId);
        return chatId ? chatKind(chatId) : undefined;
      },
    },
    {
      field: 'fromMe',
      kind: 'boolean',
      operators: BOOLEAN_OPERATORS,
      resolve: data => data.fromMe === true,
    },
    {
      field: 'hasMedia',
      kind: 'boolean',
      operators: BOOLEAN_OPERATORS,
      // Edit events carry an explicit marker rather than a media blob; preserve the blob-based
      // behaviour for received/sent messages while making the common message filter meaningful.
      resolve: data => data.hasMedia === true || data.media != null,
    },
    {
      field: 'mentions',
      kind: 'idArray',
      operators: ID_OPERATORS,
      resolve: data => (Array.isArray(data.mentionedIds) ? (data.mentionedIds as unknown[]) : []),
    },
  ],
};

/** `message.received` -> `message`. */
export function eventFamily(event: string): string {
  const dot = event.indexOf('.');
  return dot === -1 ? event : event.slice(0, dot);
}

export function getFieldDefinition(family: string, field: string): FieldDefinition | undefined {
  return FILTER_FIELDS[family]?.find(f => f.field === field);
}

/** Find a field across all families (used by validation, which is family-agnostic). */
export function findFieldDefinition(field: string): FieldDefinition | undefined {
  for (const defs of Object.values(FILTER_FIELDS)) {
    const found = defs.find(f => f.field === field);
    if (found) return found;
  }
  return undefined;
}
