/**
 * Extended type definitions for whatsapp-web.js features
 * that are not included in the library's TypeScript definitions.
 */
import { Chat, Client, Message } from 'whatsapp-web.js';

/**
 * A WhatsApp ID (Wid) as serialized by whatsapp-web.js, e.g. `{ _serialized: '120363xxx@g.us' }`.
 *
 * WA Web build 2.3000.x (~2026-07-14) renamed this property to the minifier-mangled `$1`, breaking
 * every `_serialized` read at once (#747). The image build backports upstream's id normalization
 * (`scripts/patch-wwebjs-201832.js`), which restores `_serialized` on the structures it covers — but
 * `Reaction` is not one of them, so `$1` is declared here for the callsites that must read it
 * directly. Both are optional: exactly one is present depending on the WA Web build.
 */
export interface SerializedWid {
  _serialized?: string;
  $1?: string;
}

/**
 * Read a page-context Wid's serialized id under either property name, or undefined when neither is
 * present. Every raw-Wid read goes through this: the rename lands on all of them at once, and a
 * site that reads `_serialized` alone silently yields undefined — which `String()` then turns into
 * the literal id `"undefined"`, an id that looks real and addresses nothing.
 */
export function readWid(wid: SerializedWid | string | null | undefined): string | undefined {
  if (typeof wid === 'string') return wid || undefined;
  return wid?._serialized ?? wid?.$1 ?? undefined;
}

/**
 * Raw group metadata as returned by `chat.groupMetadata.serialize()`.
 * The field that links a community sub-group to its parent community has
 * varied across whatsapp-web.js/WA Web versions, so multiple known
 * candidates are declared here defensively.
 */
export interface GroupMetadataRaw {
  parentGroup?: SerializedWid | string | null;
  linkedParentGroup?: SerializedWid | string | null;
  linkedParent?: SerializedWid | string | null;
  /** Only admins can post (WA Web group model; written by GroupChat.setMessagesAdminsOnly). */
  announce?: boolean;
  /** Only admins can edit group info (written by GroupChat.setInfoAdminsOnly). */
  restrict?: boolean;
  /** Disappearing-messages timer in seconds, when WA Web reports one on the group model. */
  ephemeralDuration?: number;
  /**
   * Who may add participants. Typed loosely on purpose: whatsapp-web.js declares this `boolean`
   * (index.d.ts:890, documented as "true = only admins") but actually writes WhatsApp's raw strings
   * `'admin_add'`/`'all_member_add'` (GroupChat.js:476), and the WA Web model it is read from uses
   * the strings too. Accepting both keeps the adapter honest about what can arrive.
   */
  memberAddMode?: string | boolean;
}

/**
 * WhatsApp Group Chat with group-specific properties and methods.
 */
export interface GroupChat extends Omit<Chat, 'isReadOnly' | 'getLabels'> {
  participants: Array<{
    id: { _serialized: string; user: string };
    name?: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
  description?: string;
  owner?: { _serialized: string };
  createdAt?: number;
  isReadOnly?: boolean;
  isAnnounce?: boolean;
  groupMetadata?: GroupMetadataRaw;
  addParticipants(
    ids: string[],
    options?: Record<string, unknown>,
  ): Promise<Record<string, { code: number; message: string; isInviteV4Sent: boolean }> | string>;
  removeParticipants(ids: string[]): Promise<{ status: number }>;
  promoteParticipants(ids: string[]): Promise<{ status: number }>;
  demoteParticipants(ids: string[]): Promise<{ status: number }>;
  leave(): Promise<void>;
  /** Resolves false when WA Web rejects the change (e.g. no admin rights) — does not throw. */
  setSubject(subject: string): Promise<boolean>;
  /** Resolves false when WA Web rejects the change (e.g. no admin rights) — does not throw. */
  setDescription(desc: string): Promise<boolean>;
  getLabels(): Promise<Array<{ id: string; name: string; hexColor: string }>>;
  addLabel(id: string): Promise<void>;
  removeLabel(id: string): Promise<void>;
  getInviteCode(): Promise<string>;
  revokeInvite(): Promise<string>;
  /** Resolves false when the account lacks admin rights (does not throw). */
  setMessagesAdminsOnly(adminsOnly?: boolean): Promise<boolean>;
  /** Resolves false when the account lacks admin rights (does not throw). */
  setInfoAdminsOnly(adminsOnly?: boolean): Promise<boolean>;
  /** Only admins may add participants when true (index.d.ts:2205). */
  setAddMembersAdminsOnly(adminsOnly?: boolean): Promise<boolean>;
  /** Resolves false when the account lacks admin rights (does not throw). */
  setPicture(media: unknown): Promise<boolean>;
  /** Resolves false when the account lacks admin rights (does not throw). */
  deletePicture(): Promise<boolean>;
}

/**
 * WhatsApp Message with reaction methods.
 */
export interface MessageWithReactions extends Omit<Message, 'hasReaction' | 'getReactions' | 'react'> {
  react(emoji: string): Promise<void>;
  hasReaction?: boolean;
  getReactions(): Promise<
    Array<{
      id: string;
      senders: Array<{ senderId: string; reaction: string; timestamp: number }>;
    }>
  >;
}

/**
 * WhatsApp Business Client with label and channel methods.
 */
export interface BusinessClient extends Omit<
  Client,
  | 'subscribeToChannel'
  | 'unsubscribeFromChannel'
  | 'getLabels'
  | 'getLabelById'
  | 'getChannels'
  | 'getChatsByLabelId'
  | 'createChannel'
  | 'deleteChannel'
> {
  getLabels(): Promise<Array<{ id: string; name: string; hexColor: string }>>;
  getLabelById(id: string): Promise<{ id: string; name: string; hexColor: string } | null>;
  /** Chats carrying a label. whatsapp-web.js has the read but exposes no label create/update/delete. */
  getChatsByLabelId(
    labelId: string,
  ): Promise<
    Array<
      | { id?: { _serialized?: string }; name?: string; isGroup?: boolean; unreadCount?: number; timestamp?: number }
      | undefined
    >
  >;
  getChannels(): Promise<WwjsChannelData[]>;
  /** Takes a channel ID (`…@newsletter`), NOT an invite code; resolves true only on success. */
  subscribeToChannel(channelId: string): Promise<boolean>;
  /**
   * Resolves a RESULT OBJECT on success and an error STRING on failure — it does not throw
   * (Client.js:2474-2510), so callers must narrow before using it.
   */
  createChannel(
    title: string,
    options?: { description?: string },
  ): Promise<{ title?: string; nid: { _serialized?: string; $1?: string }; inviteLink?: string } | string>;
  /** False when the channel was not found or the server refused. */
  deleteChannel(channelId: string): Promise<boolean>;
  /** Resolves true only when the unsubscription completed. */
  unsubscribeFromChannel(id: string, options?: Record<string, unknown>): Promise<boolean>;
}

/**
 * WhatsApp Channel/Newsletter data.
 */
export interface WwjsChannelData {
  id: { _serialized?: string; $1?: string } | string;
  name?: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  verified?: boolean;
  fetchMessages(opts: { limit: number }): Promise<WwjsChannelMessage[]>;
}

/**
 * Channel message data.
 */
export interface WwjsChannelMessage {
  /** `SerializedWid`, not `{ _serialized: string }`: the latter makes the `$1` rename unreadable. */
  id: SerializedWid | string;
  body?: string;
  type?: string;
  timestamp?: number;
  hasMedia?: boolean;
  mediaUrl?: string;
}

/**
 * Group creation result.
 */
export interface GroupCreateResult {
  gid: { _serialized: string };
}
