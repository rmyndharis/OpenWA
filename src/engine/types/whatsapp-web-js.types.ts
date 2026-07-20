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
  addParticipants(ids: string[]): Promise<void>;
  removeParticipants(ids: string[]): Promise<void>;
  promoteParticipants(ids: string[]): Promise<void>;
  demoteParticipants(ids: string[]): Promise<void>;
  leave(): Promise<void>;
  setSubject(subject: string): Promise<void>;
  setDescription(desc: string): Promise<void>;
  getLabels(): Promise<Array<{ id: string; name: string; hexColor: string }>>;
  addLabel(id: string): Promise<void>;
  removeLabel(id: string): Promise<void>;
  getInviteCode(): Promise<string>;
  revokeInvite(): Promise<string>;
  /** Resolves false when the account lacks admin rights (does not throw). */
  setMessagesAdminsOnly(adminsOnly?: boolean): Promise<boolean>;
  /** Resolves false when the account lacks admin rights (does not throw). */
  setInfoAdminsOnly(adminsOnly?: boolean): Promise<boolean>;
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
  'subscribeToChannel' | 'unsubscribeFromChannel' | 'getLabels' | 'getLabelById' | 'getChannels'
> {
  getLabels(): Promise<Array<{ id: string; name: string; hexColor: string }>>;
  getLabelById(id: string): Promise<{ id: string; name: string; hexColor: string } | null>;
  getChannels(): Promise<WwjsChannelData[]>;
  subscribeToChannel(inviteCode: string): Promise<WwjsChannelData>;
  unsubscribeFromChannel(id: string): Promise<void>;
}

/**
 * WhatsApp Channel/Newsletter data.
 */
export interface WwjsChannelData {
  id: { _serialized: string } | string;
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
