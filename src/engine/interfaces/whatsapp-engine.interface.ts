// WhatsApp Engine Interface - Abstract layer for WA engines
//
// Identity contract (the engine boundary is an anti-corruption layer for WhatsApp's id dialects):
// every JID an engine EMITS in a neutral field (`from` / `to` / `chatId` / `author` / contact + chat
// `id`, etc.) is in the NEUTRAL dialect, so application code never has to know which engine produced
// it. The neutral dialect is small:
//   - `<phone>@c.us`  a user known by phone (the raw `@s.whatsapp.net` form folds into this)
//   - `<id>@g.us`     a group
//   - `<lid>@lid`     a user known ONLY by privacy id - phone genuinely unknown (a first-class state)
//   - `status@broadcast` / `<id>@newsletter` / `<id>@broadcast`  special channels
//   - never `@s.whatsapp.net`, never a `:device` suffix
// Resolution rule: prefer `@c.us` (resolve a lid to its phone when the mapping is known), fall back to
// `@lid` only when it can't be resolved. See `engine/identity/wa-id.ts` for the shared implementation.
// (Ids the engine ACCEPTS - e.g. `sendTextMessage(chatId)` - may be neutral; the adapter de-normalizes
// to its own dialect. Full inbound + outbound conformance is being rolled out per-engine.)

import type { ChatKind } from '../identity/wa-id';

export enum EngineStatus {
  DISCONNECTED = 'disconnected',
  INITIALIZING = 'initializing',
  QR_READY = 'qr_ready',
  AUTHENTICATING = 'authenticating',
  READY = 'ready',
  ACTION_REQUIRED = 'action_required',
  FAILED = 'failed',
}

export interface MessageResult {
  id: string;
  timestamp: number;
}

/**
 * A send payload that can quote an earlier message, turning the send into a reply.
 *
 * Deliberately a PROPERTY on the payload rather than a parameter on the engine methods: the parity
 * gate reads call-shaped members out of this file, so a new method would demand a capability-matrix
 * row while a property demands nothing (see engine-parity.spec.ts MEMBER_RE).
 *
 * The id is engine-specific and the adapters do NOT harmonize it: whatsapp-web.js matches the
 * serialized message id, Baileys looks the raw key id up in its local store and can only quote a
 * message it has already persisted.
 */
export interface Quotable {
  /** Quote this message id in the send. Omit for a plain, unquoted send. */
  quotedMessageId?: string;
}

export interface MediaInput extends Quotable {
  mimetype: string;
  data: Buffer | string; // Buffer or base64 or URL
  /** Caller-supplied filename wins. Document sends fall back to 'file' when omitted (wwebjs first derives the URL basename); image/video/audio sends carry no filename. */
  filename?: string;
  caption?: string;
  /** Neutral WIDs (`<phone>@c.us`) to @mention in the caption. The adapter de-normalizes per engine. */
  mentions?: string[];
  /** When true, send as a WhatsApp voice note (PTT). audio-only; ignored by other media types. */
  ptt?: boolean;
}

/**
 * Engine-neutral message type. Each adapter maps its library's native message-type tokens
 * (e.g. whatsapp-web.js `chat`/`ptt`/`vcard`) to this vocabulary at the adapter boundary,
 * so no consumer outside the adapter sees engine-specific type strings. `unknown` covers any
 * type the active engine reports that doesn't map to a first-class kind.
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'call'
  | 'revoked'
  // WhatsApp Business commerce: a customer's cart placed from the catalog, and a single product
  // card shared into a chat. Both carry the ids the commerce APIs need — see `IncomingMessage`.
  | 'order'
  | 'product'
  // A message WhatsApp deliberately withheld from linked/companion devices (e.g. high-security
  // business OTPs): the payload is absent by design, not unparseable. See `mapBaileysMessageType`.
  | 'masked'
  | 'unknown';

export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: MessageType;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  /** User-facing chat kind of the conversation this message belongs to (derived from `chatId`). */
  kind: ChatKind;
  /**
   * True for a status/story broadcast (not a real conversation). Set by the adapter so engine-neutral
   * code can skip these without matching an engine-specific pseudo-JID (e.g. `status@broadcast`).
   */
  isStatusBroadcast?: boolean;
  /** WhatsApp ephemeral/disappearing-messages timer in seconds. Set per-chat on each message
   *  in the raw payload. 0 or undefined = no disappearing timer.
   *  Known values: 86400 (24h), 604800 (7d), 7776000 (90d). */
  ephemeralDuration?: number;
  /** For group messages, the WID of the participant who actually sent it (`from` is the group JID there). */
  author?: string;
  /** WIDs @mentioned in the message (empty/absent when none). Surfaced for command targeting. */
  mentionedIds?: string[];
  /** Set for `call` (call_log) messages: video vs voice, and whether an incoming call went unanswered. */
  call?: { video: boolean; missed: boolean };
  /**
   * Set for `order` messages: a cart the customer placed from the business catalog. The message
   * carries no line items — `orderId` plus the single-order `token` are the correlation handle a
   * caller redeems against WhatsApp's own order lookup, which this project does not expose, so both
   * must survive to that caller. Both engines populate them.
   */
  order?: {
    orderId: string;
    /** Opaque, single-order credential. Pass through unchanged; do not log it. */
    token?: string;
  };
  /**
   * Set for `product` messages: the catalog product shared into the chat. `productId` identifies it
   * within `businessOwnerJid`'s catalog, so it resolves through the catalog routes only when that
   * catalog is the session's own. Both engines populate `productId`; the rest are best-effort.
   */
  product?: {
    productId: string;
    title?: string;
    description?: string;
    businessOwnerJid?: string;
  };
  /**
   * Set by the adapter when the sender is identified by a privacy id (e.g. a WhatsApp `@lid`) rather
   * than a phone number, so engine-neutral code can decide whether to attempt phone resolution without
   * matching an engine-specific JID scheme.
   */
  isLidSender?: boolean;
  /**
   * Best-effort phone number (MSISDN digits) of the sender, resolved from a privacy id when inline
   * resolution is enabled (`RESOLVE_LID_TO_PHONE`). `null` when the engine cannot map it. Only
   * populated for `isLidSender` messages.
   */
  senderPhone?: string | null;
  /** Sender contact info, best-effort from the WhatsApp Web cache. Sync fields only (no network). */
  contact?: MessageContact;
  /** Styling of a text status/story: background as `#RRGGBB`. Only set by engines that expose it. */
  backgroundColor?: string;
  /** Styling of a text status/story: the WhatsApp font index. Only set by engines that expose it. */
  font?: number;
  media?: {
    mimetype: string;
    filename?: string;
    data?: string; // base64; absent when the payload was omitted (see `omitted`)
    /** True when the media blob was dropped: a size cap, a timeout, a disabled download, or a failed one. */
    omitted?: boolean;
    /** Decoded byte size of the media; always set when `omitted` is true. */
    sizeBytes?: number;
  };
  quotedMessage?: {
    id: string;
    body: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    description?: string;
    address?: string;
    url?: string;
  };
}

/**
 * Synchronous (already-resolved, no network call) fields of a sender contact, surfaced on
 * {@link IncomingMessage}. Async getters (profile pic / about / formatted number) are intentionally
 * NOT included — they hit WhatsApp servers per message and risk rate-limit/ban. All optional; a key
 * is present only when the engine populated it.
 */
export interface MessageContact {
  /** Sender JID (`…@c.us` or a `…@lid` privacy id). */
  id?: string;
  /** Phone digits, best-effort. For `@lid` senders the authoritative number is `IncomingMessage.senderPhone`. */
  number?: string;
  name?: string;
  pushName?: string;
  shortName?: string;
  /** whatsapp-web.js contact type token. */
  type?: string;
  /** Saved in the account's address book. */
  isMyContact?: boolean;
  /** Is a WhatsApp user. */
  isWAContact?: boolean;
  isBusiness?: boolean;
  isEnterprise?: boolean;
  /** Business verified name. */
  verifiedName?: string;
  /** Business verification level. */
  verifiedLevel?: number;
  isBlocked?: boolean;
  /** Label IDs (CRM). Names are not resolved — that would need a network call. */
  labels?: string[];
}

export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
  profilePicUrl?: string;
}

export interface Group {
  id: string;
  name: string;
  participantsCount?: number;
  isAdmin?: boolean;
  /** JID of the parent community this group is linked to, or null if standalone. */
  linkedParentJID?: string | null;
}

export interface GroupParticipant {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/**
 * Outcome of a group membership write (add/remove/promote/demote) for ONE participant. Engines
 * that report per-participant results map them verbatim (whatsapp-web.js `addParticipants` resolves
 * a `{[participantId]: {code, message}}` object; Baileys `groupParticipantsUpdate` resolves a
 * `[{status, jid}]` array).
 *
 * whatsapp-web.js remove/promote/demote confirm only the batch, but an install-time patch
 * (`scripts/patch-wwebjs-participant-arity.js`) makes the page report which requested ids resolved
 * to actual members, so those entries are per-participant too: an id the page dropped is reported
 * `404` rather than confirmed. On a tree where that patch was not applied the marker is absent and
 * the adapter falls back to one batch-confirmed entry per requested participant, which is all the
 * library reports there.
 *
 * `status` is the engine's own code when it reported one (e.g. 200 ok, 403 invite-only/not-admin,
 * 404 not registered or not a member, 409 already a member).
 */
export interface ParticipantOperationResult {
  /** Neutral participant id the outcome belongs to. */
  id: string;
  /** True only when the engine confirmed the change for THIS participant. */
  success: boolean;
  /** Engine-reported status code, when it gave one. */
  status?: number;
  /** Engine-reported human-readable reason, when it gave one. */
  message?: string;
}

/**
 * Who may add participants to a group. Neutral vocabulary: the engines disagree on how they encode
 * this — Baileys uses a boolean where `true` means everyone, whatsapp-web.js carries WhatsApp's own
 * `'all_member_add'`/`'admin_add'` strings (despite typing the field as a boolean with the opposite
 * sense) — so adapters normalise to this on the way out and de-normalise on the way in.
 */
export type GroupMemberAddMode = 'all' | 'admins';

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: GroupParticipant[];
  isReadOnly?: boolean;
  isAnnounce?: boolean;
  /** Only admins can send messages (the WhatsApp "announce" group setting). */
  announce?: boolean;
  /** Only admins can edit group info — subject, description, picture (the WhatsApp "locked"/restrict setting). */
  locked?: boolean;
  /** Disappearing-messages timer in seconds; 0 or undefined = off. */
  ephemeralSeconds?: number;
  /** Who may add participants. Undefined when the engine did not report it. */
  memberAddMode?: GroupMemberAddMode;
  /** JID of the parent community this group is linked to, or null if standalone. */
  linkedParentJID?: string | null;
}

/**
 * What an invite code discloses about a group BEFORE joining it.
 *
 * Deliberately not `GroupInfo`: that carries a participant list, and a non-member has no such list —
 * WhatsApp discloses at most a count. Reusing it would force an empty array that reads as "this
 * group has no members", which is a different and wrong claim.
 */
export interface GroupJoinInfo {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  /** Unix seconds the group was created, when the engine reports it. */
  createdAt?: number;
  /** How many members, when disclosed. There is no list to give — you are not in the group yet. */
  participantCount?: number;
}

/** How a join request was made. Neutral vocabulary; both engines' tokens map onto it. */
export type GroupMembershipRequestMethod = 'invite_link' | 'non_admin_add' | 'linked_group_join';

/**
 * One pending request to join a group that has join-approval turned on. Mapped at the adapter
 * boundary from engine shapes that disagree on everything: whatsapp-web.js resolves raw
 * page-context store objects (wid objects, PascalCase method tokens), Baileys bare wire attrs
 * (engine-dialect jids, snake_case tokens, stringly timestamps). Fields the engine did not report
 * are omitted rather than defaulted.
 */
export interface GroupMembershipRequest {
  /** Neutral id of the user asking to join. */
  participantId: string;
  /** Who created the request when the engine reports it (differs from the requester on a non-admin add). */
  addedById?: string;
  /** How the request was made, when the engine reports a token this shape models. */
  method?: GroupMembershipRequestMethod;
  /** Unix seconds the request was created, when the engine reports it. */
  requestedAt?: number;
}

/**
 * A caller-supplied link preview, used instead of fetching one.
 *
 * Nothing is fetched for these: the caller states the metadata, so the gateway makes no outbound
 * request at all — which also means a preview can be attached for a URL this server could not reach.
 */
export interface CustomLinkPreview {
  /** The URL as it appears in the message text; WhatsApp anchors the preview to it. */
  url: string;
  /** Required — WhatsApp will not render a preview without one. */
  title: string;
  description?: string;
}

export interface ContactCard extends Quotable {
  name: string;
  number: string;
}

export interface LocationInput extends Quotable {
  latitude: number;
  longitude: number;
  description?: string;
  address?: string;
}

export interface PollInput extends Quotable {
  /** Poll question / title. */
  name: string;
  /** Options to vote on (WhatsApp accepts between 2 and 12). */
  options: string[];
  /** When true a voter can pick several options; default is single choice. */
  allowMultipleAnswers?: boolean;
}

export interface ReactionSender {
  senderId: string;
  emoji: string;
  timestamp: number;
}

export interface MessageReaction {
  emoji: string;
  senders: ReactionSender[];
}

// Phase 3: Labels (WhatsApp Business)
export interface Label {
  id: string;
  name: string;
  hexColor: string;
}

/**
 * A label to create or update. Keyed on a CALLER-SUPPLIED id, because that is exactly what the
 * underlying operation is: WhatsApp's app-state carries one `label_edit` write indexed by label id,
 * and whether it creates or updates depends only on whether that id already exists. There is no
 * server-assigned id to hand back, so inventing one here would be inventing a contract the protocol
 * does not have — and could silently overwrite an existing label.
 */
export interface LabelInput {
  id: string;
  name?: string;
  /**
   * WhatsApp's colour INDEX (0-19), not a hex value. Deliberately not the `hexColor` the read path
   * returns: neither library exposes the index-to-hex mapping — whatsapp-web.js passes hex straight
   * through from the WA Web store and Baileys only ever speaks in indices — so a translation table
   * here would be guesswork that silently sets the wrong colour.
   */
  color?: number;
}

// Phase 3: Status/Stories
export interface Status {
  id: string;
  contact: {
    id: string;
    name?: string;
    pushName?: string;
  };
  /**
   * `voice` covers an audio status posted as a voice note (PTT). It was added alongside voice status
   * posting; before that a voice status read back as `text`, since anything that was not an image or
   * a video collapsed to it.
   */
  type: 'text' | 'image' | 'video' | 'voice';
  caption?: string;
  mediaUrl?: string;
  /** Downloaded media bytes for an image/video status, when the engine fetched them (see `capInboundMediaFor`). */
  media?: IncomingMessage['media'];
  backgroundColor?: string;
  font?: number;
  timestamp: Date;
  expiresAt: Date;
}

export interface StatusPostOptions {
  /**
   * Neutral JIDs (@c.us / @lid) permitted to see the status. Maps to Baileys statusJidList.
   * REQUIRED on the Baileys engine (it rejects an absent/empty list with a 400); ignored by
   * whatsapp-web.js, which broadcasts to the account's status-privacy audience.
   */
  recipients?: string[];
  /** Hex background colour (#RRGGBB). Honoured on text and voice statuses (Baileys engine). */
  backgroundColor?: string;
  /** Font index. Honoured on text and voice statuses (Baileys engine). */
  font?: number;
  /** Caption. Image/video status only. */
  caption?: string;
}

export interface StatusResult {
  statusId: string;
  timestamp: Date;
  expiresAt: Date;
}

// Phase 3: Channels/Newsletter
export interface Channel {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  picture?: string;
  verified?: boolean;
  createdAt?: number;
}

export interface ChannelMessage {
  id: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  mediaUrl?: string;
}

// Phase 3: Catalog (WhatsApp Business)
export interface Catalog {
  id: string;
  name: string;
  description?: string;
  productCount: number;
  url: string;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  priceFormatted: string;
  imageUrl?: string;
  url: string;
  isAvailable: boolean;
  retailerId?: string;
}

export interface ProductQueryOptions {
  page?: number;
  limit?: number;
}

export interface PaginatedProducts {
  products: Product[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Lightweight summary of a chat, exposed to the dashboard's real-time chats view.
 * Only library-agnostic primitives are leaked here; raw whatsapp-web.js objects are
 * mapped to this shape inside the adapter.
 */
export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  /** User-facing chat kind. `isGroup` is retained for back-compat; `kind` is the full discriminator. */
  kind: ChatKind;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
  /** Archived state, as set via `POST /sessions/{sessionId}/chats/archive`. */
  archived: boolean;
  /** Pinned state, as set via `POST /sessions/{sessionId}/chats/pin`. */
  pinned: boolean;
  /**
   * Muted state, as set via `POST /sessions/{sessionId}/chats/mute`. The verdict a caller needs to
   * label a mute/unmute control: whatsapp-web.js derives `Chat.isMuted` itself, and Baileys compares
   * a persisted `muteEndTime` (epoch milliseconds) against now. `muteExpiration` carries the instant.
   */
  muted: boolean;
  /**
   * Epoch MILLISECONDS at which the mute ends, present only when `muted` is true; `0` means muted
   * indefinitely. Milliseconds is the same unit as `POST /sessions/{sessionId}/chats/mute`
   * `muteUntil`, so a FINITE value can be written straight back (`mute-chat.dto.ts` documents that
   * unit and why a seconds value is a trap). The `0` an indefinite mute reports is the exception:
   * `muteUntil` requires a real future instant, so re-apply an indefinite mute with a far-future
   * timestamp rather than `0`.
   */
  muteExpiration?: number;
}

/**
 * Engine-neutral chat presence state. `typing`/`recording` show the indicator to the chat;
 * `paused` clears it. Best-effort: engines without a presence concept may no-op.
 */
export type ChatState = 'typing' | 'recording' | 'paused';

/**
 * Which kind of call a generated link opens. `audio` is the neutral spelling; Baileys uses the same
 * word, whatsapp-web.js calls it `voice`, and WhatsApp's own URL path is `/voice/`.
 */
export type CallLinkType = 'audio' | 'video';

/**
 * Engine-neutral message delivery status. Each adapter maps its native delivery signal
 * (e.g. whatsapp-web.js MessageAck integers, Baileys WAMessageStatus) to this vocabulary,
 * so no consumer outside the adapter sees engine-specific ack codes.
 */
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Structured payload for a remotely-revoked ("deleted for everyone") message.
 * The engine layer never emits a localized display string; `body` is intentionally
 * empty and the dashboard renders the localized "message deleted" text.
 */
export interface RevokedMessage {
  id: string;
  /**
   * Serialized id of the ORIGINAL message that was deleted (when available).
   *
   * This is the reliable cross-engine field for reconciling the deleted message in
   * your own storage — both adapters populate it with the original message id:
   *  - whatsapp-web.js: `id` is the revocation NOTIFICATION (a distinct message), so
   *    `id !== revokedId`. `revokedId` may be undefined when the original is not in
   *    the local store.
   *  - Baileys: the revoke arrives as a protocolMessage whose key already points at
   *    the original, so `id === revokedId`.
   *
   * Consumers should match on `revokedId` (falling back to `id`) rather than `id`.
   */
  revokedId?: string;
  chatId: string;
  from: string;
  to: string;
  type: 'revoked';
  body: '';
  timestamp: number;
}

export interface EditedMessage {
  messageId: string;
  chatId: string;
  body: string;
  senderId: string;
  from: string;
  to: string;
  fromMe: boolean;
  isGroup: boolean;
  type: MessageType;
  hasMedia: boolean;
  /** For group messages, the participant that authored the edited message. */
  author?: string;
  /** WIDs mentioned by the edited message's latest content. */
  mentionedIds?: string[];
  /** Unix seconds when the edit occurred (not the original message creation time). */
  timestamp: number;
}

export interface ReactionEvent {
  messageId: string;
  chatId: string;
  reaction: string;
  senderId: string;
}

/**
 * A group membership or metadata change, mapped at the adapter boundary to this neutral
 * shape so consumers never see engine-specific payloads:
 *  - whatsapp-web.js: `group_join` / `group_leave` / `group_update` /
 *    `group_membership_request` (GroupNotification).
 *  - Baileys: `group-participants.update` (add/remove only — promote/demote are not
 *    surfaced), `groups.update` (subject/desc/announce/restrict) and `group.join-request`
 *    (action 'created' only — the wwebjs event has no revoke/reject counterpart, so only
 *    the shared signal is surfaced; rc13 itself emits the event only for non-admin-add
 *    requests — the direct self-request stub 144 is unhandled upstream, marked TODO at
 *    Utils/process-message.js:569 — so an invite-link self-request may not fire on Baileys).
 * All ids are in the neutral dialect (`@g.us` / `@c.us`; a lid stays `<id>@lid` when the
 * lid->phone mapping is unknown).
 */
export interface GroupEvent {
  kind: 'join' | 'leave' | 'update' | 'join_request';
  /** Neutral group id (`@g.us`). */
  groupId: string;
  /** Who performed the action, neutral user id when the engine reports one. */
  actorId?: string;
  /** Affected users (join/leave), or the users asking to join (join_request), neutral ids. Empty for metadata updates. */
  participantIds: string[];
  /** Metadata delta for kind 'update'; absent or partially populated for join/leave. */
  changes?: { subject?: string; description?: string; announce?: boolean; locked?: boolean };
  /** Unix seconds when the change occurred (engine timestamp when available, else receipt time). */
  timestamp: number;
}

/**
 * An incoming (ringing) call, mapped at the adapter boundary to this neutral shape:
 *  - whatsapp-web.js: the client `call` event (a `Call` object the adapter caches so a later
 *    `rejectCall` can act on it — the object is only usable while the call is live).
 *  - Baileys: the `call` event's `offer` status entries (other statuses are lifecycle updates and
 *    are not surfaced).
 * All ids are in the neutral dialect (`@c.us`; a lid caller stays `<id>@lid` when the lid->phone
 * mapping is unknown, resolved via the inline phone twin when the engine provides one).
 */
export interface IncomingCallEvent {
  /** Engine call id; the handle `rejectCall` accepts while the call is still ringing. */
  callId: string;
  /** Neutral caller id. */
  from: string;
  isVideo: boolean;
  isGroup: boolean;
  /** Unix seconds when the call was created (engine timestamp). */
  timestamp: number;
}

/**
 * A restriction WhatsApp itself has placed on the account behind a session — as opposed to a
 * connection fault, a stale credential, or an operator action.
 *
 * The two engines report genuinely different things, so `kind` is the discriminator consumers act
 * on rather than a lowest common denominator:
 *
 *  - `reachout_timelock` (Baileys) — the account stays connected and existing chats keep working;
 *    WhatsApp only blocks *starting new conversations*. Reported first-class by the library
 *    (`connection.update.reachoutTimeLock`), including when it is lifted.
 *  - `tos_block` / `proxy_block` (whatsapp-web.js) — a connection-level refusal: WhatsApp Web drops
 *    the socket and the engine cannot stay linked at all. Derived from the `WAState` the library
 *    reports on its `disconnected` event, which is the only channel that carries it.
 *
 * That difference is load-bearing for clearing: a `reachout_timelock` can only be resolved by an
 * explicit lift signal, whereas a connection-scoped kind is disproved the moment the session reaches
 * READY again — the block would have prevented that.
 */
export interface AccountRestriction {
  kind: 'reachout_timelock' | 'tos_block' | 'proxy_block';
  /**
   * The engine's own token for the cause, kept verbatim so an operator can search for it and so a
   * new upstream value is surfaced rather than flattened: the `WAState` string on whatsapp-web.js
   * (`TOS_BLOCK`, `SMB_TOS_BLOCK`, `PROXYBLOCK`) or the enforcement type on Baileys (`BIZ_QUALITY`,
   * `WEB_COMPANION_ONLY`, one of the BIZ_COMMERCE_VIOLATION_* values, …).
   */
  code: string;
  /** Unix ms when enforcement ends, when the engine states it (Baileys timelocks only). */
  expiresAt?: number;
}

/**
 * Neutral presence states, matching what WhatsApp itself distinguishes: whether the contact is
 * reachable, and whether they are actively typing or recording in the chat being watched.
 */
export type PresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';

/** One participant's presence within a chat. */
export interface ParticipantPresence {
  /** Neutral participant id. In a 1:1 chat this is the chat's own id. */
  id: string;
  state: PresenceState;
  /**
   * Unix SECONDS the contact was last seen, when WhatsApp discloses it. Absent for contacts whose
   * privacy settings hide last-seen — which is the common case, not an error.
   */
  lastSeen?: number;
}

/**
 * Presence in one chat. A group reports every participant WhatsApp chose to tell us about, so this
 * is a list rather than a single state even for a 1:1 chat, where it holds exactly one entry.
 */
export interface PresenceUpdateEvent {
  chatId: string;
  participants: ParticipantPresence[];
  /** How many group members are online, when the engine reports it (groups only). */
  groupOnlineCount?: number;
}

/**
 * How a ringing call ended.
 *
 * `terminate` is deliberately NOT mapped to an outcome. WhatsApp uses it both for a caller hanging
 * up before the call was answered and for either side ending an answered one, and the event carries
 * nothing that separates the two — reporting it as either would be wrong half the time. Telling
 * those apart needs call-duration tracking, which is its own piece of work.
 */
export type CallOutcome = 'accepted' | 'rejected' | 'missed';

/**
 * A call that was ringing has ended.
 *
 * The engines report the outcome but not WHO caused it: an accept can come from any of the account's
 * linked devices, and a reject can equally be the account declining or WhatsApp giving up. So this
 * says what happened to the call, never who did it.
 */
export interface CallOutcomeEvent {
  /** The same id the matching `onCall` offer carried. */
  callId: string;
  /** Neutral caller id. */
  from: string;
  outcome: CallOutcome;
  isVideo: boolean;
  isGroup: boolean;
  /** Unix seconds the outcome was reported (engine timestamp). */
  timestamp: number;
}

export interface EngineEventCallbacks {
  onQRCode?: (qr: string) => void;
  onReady?: (phone: string, pushName: string) => void;
  onMessage?: (message: IncomingMessage) => void;
  /**
   * Fired for messages the account itself created (outgoing) — including sends composed on a
   * linked phone, which the `message`/`onMessage` event never delivers. Used to emit `message.sent`.
   */
  onMessageCreate?: (message: IncomingMessage) => void;
  /**
   * Fired when the delivery status of an outgoing message advances. The adapter maps its native
   * delivery signal to the neutral `DeliveryStatus`, so consumers never see engine-specific codes.
   */
  onMessageAck?: (messageId: string, status: DeliveryStatus) => void;
  onMessageRevoked?: (message: RevokedMessage) => void;
  onMessageReaction?: (event: ReactionEvent) => void;
  onMessageEdited?: (message: EditedMessage) => void;
  /**
   * Fired on group membership changes (join/leave), group metadata updates
   * (subject/description/announce/locked), and pending join requests. The `kind` selects the
   * consumer event name (`group.join` / `group.leave` / `group.update` / `group.join_request`).
   */
  onGroupEvent?: (event: GroupEvent) => void;
  /**
   * Fired when an incoming call starts ringing (consumers emit `call.received`). The call can be
   * rejected via `rejectCall(callId)` only while it is still ringing — the adapter keeps the
   * engine's live call handle cached for that window.
   */
  onCall?: (event: IncomingCallEvent) => void;
  /**
   * Bulk historical messages from an engine's initial sync (e.g. Baileys `messaging-history.set`).
   * They predate the live session, so consumers persist them for the chat view but must not dispatch.
   */
  onHistoryMessages?: (messages: IncomingMessage[]) => void;
  onDisconnected?: (reason: string) => void;
  /**
   * Fired each time the engine schedules an INTERNAL reconnect attempt: a drop it retries on its own
   * and deliberately does NOT report through `onDisconnected`, because the session is still linked and
   * the credentials are still good. Purely informational, so a consumer must not tear anything down on
   * it; the engine keeps owning the retry.
   *
   * `attempt` is the 1-based number of the attempt being scheduled, and it resets once the connection
   * is back (or after a long enough healthy stretch), so attempt 1 always opens a fresh episode.
   * `nextDelayMs` is how long the engine waits before making it. Together they are what a consumer
   * needs to tell a one-second blip from a session that has been down for an hour, which the status
   * alone cannot: the engine reports INITIALIZING for the whole episode, exactly as it does for a
   * session that has never been paired.
   *
   * Optional: an engine that hands every drop to its consumer instead of retrying internally
   * (whatsapp-web.js does) simply never invokes this, because that consumer already has the drop.
   */
  onReconnecting?: (attempt: number, nextDelayMs: number) => void;
  onStateChanged?: (state: EngineStatus) => void;
  /**
   * Fired when the engine needs an operator action to keep the session healthy — currently only the
   * whatsapp-web.js onboarding-modal fallback (#982): a new account shows a "What's new" modal after
   * linking that must be acknowledged, and the adapter dismisses it automatically; this fires only if
   * that dismissal fails, so a headless deployment is told (rather than left to be logged out ~5m
   * later). The engine has already moved to ACTION_REQUIRED; `reason` carries a human-readable cause.
   * Distinct from `onError` (terminal) and `onDisconnected` (recoverable): it does NOT clear on its
   * own — once the operator has acted, the session must be restarted (stop, then start) to return
   * to READY.
   */
  onActionRequired?: (reason: string) => void;
  /**
   * Fired when the engine learns that WhatsApp has restricted (or un-restricted) the account behind
   * this session. `null` means the engine positively reports no restriction in force — it is a
   * *lift*, not "unknown", so consumers may clear state on it; an engine that simply never learns
   * anything stays silent instead.
   *
   * Purely informational: the adapter does NOT change its own status or reconnect behavior because
   * of a restriction, so this cannot turn a recoverable session into a dead one on a misread.
   * Consumers decide what a restriction is worth.
   */
  onAccountRestriction?: (restriction: AccountRestriction | null) => void;
  /**
   * Fired when WhatsApp reports presence for a chat this session subscribed to. Push-only and
   * unsolicited after the subscription: there is no way to ask for a contact's presence on demand,
   * which is why consumers keep the last reported state rather than querying for it.
   */
  onPresenceUpdate?: (event: PresenceUpdateEvent) => void;
  /**
   * Fired when a call that was ringing ends — answered, declined, or never picked up. Distinct from
   * `onCall`, which announces the ring itself: an outcome must never re-enter that path, or a call
   * being declined would look like a fresh incoming call and (with auto-reject on) be answered.
   */
  onCallOutcome?: (event: CallOutcomeEvent) => void;
  /**
   * Fired on a terminal initialization/authentication failure (e.g. Chromium
   * could not launch, or WhatsApp rejected the stored credentials). The engine
   * has already moved to FAILED; `reason` carries a human-readable cause that
   * callers may surface to operators. Distinct from `onDisconnected`, which is
   * recoverable and triggers reconnection.
   */
  onError?: (reason: string) => void;
  /**
   * Fired SYNCHRONOUSLY the instant a credential-teardown operation begins — i.e. the moment the
   * adapter kicks off the call that ends in an `fs.rm` of this session's on-disk WhatsApp auth
   * directory. The argument is the SAME promise the adapter is about to await (or, for a
   * WhatsApp-originated unlink, a promise the adapter controls that represents the same rm).
   *
   * Unlike the other callbacks, this one is NOT guarded on the engine still being live: a logout
   * that captured the engine registers its destructive promise even as a concurrent stop()/delete()
   * evicts that engine, because the rm it ends in targets the session NAME's auth dir and would
   * otherwise race a (re)created session under that same name. The lifecycle tracks the promise
   * (keyed by the immutable captured session NAME) so start()/delete()/executeReconnect can wait
   * (bounded, fail-closed) for it to settle before touching that path.
   *
   * Adapters that never remove credentials on their own (e.g. Baileys until a later task wires its
   * WhatsApp-originated cleanup) simply never invoke this.
   */
  onCredentialTeardownStarted?: (operation: Promise<void>) => void;
  /**
   * Synchronous atomic claim for ONE automatic credential-reset attempt within a single reconnect
   * episode. The adapter calls this BEFORE it begins the destructive credential reset that ends in
   * an `fs.rm` of this session's on-disk auth dir (the stuck-auth recovery path: a session that
   * authenticated but never reached readiness). Returns `true` exactly once per episode — the claim
   * is owned by the session lifecycle, so it survives an automatic reconnect that builds a FRESH
   * adapter (which would otherwise reset an instance-local budget and wipe LocalAuth every
   * generation, looping forever). Returns `false` once the budget is spent, and the adapter MUST
   * then fail terminally (FAILED + `onError`) WITHOUT touching the auth dir.
   *
   * SYNCHRONOUS by contract: the race between the stuck-auth timeout and any concurrent
   * start()/reconnect is resolved within a single event-loop turn. The adapter does NOT await it.
   *
   * Optional: when absent (standalone adapter use/test, no session lifecycle) the adapter falls back
   * to its own instance-local one-shot boolean so standalone behavior is unchanged.
   */
  claimStuckAuthRecovery?: () => boolean;
}

// ---------------------------------------------------------------------------
// Capability slices
//
// The engine surface is one contract per consumer domain rather than one flat list: each
// interface below is the slice one domain uses, and IWhatsAppEngine at the end of this section
// composes them all. Adapters keep implementing the union; a consumer that only touches one
// domain can narrow to the slice it needs. The slices deliberately live in this same file: the
// parity gate (engine-parity.spec.ts) reads the method inventory straight out of this file's
// text, so every method declaration stays here, indented as a member, doc comment attached.
// ---------------------------------------------------------------------------

/**
 * Session lifecycle, connection health, and identity: start/stop the engine, observe its status,
 * and read the identity it authenticated as. The QR and pairing-code members are the
 * link-a-new-session surface.
 *
 * Status and liveness stay with lifecycle rather than forming their own slice because the
 * session-lifecycle consumer uses them for exactly that: deciding whether a session is alive.
 */
export interface SessionLifecycleCapability {
  initialize(callbacks: EngineEventCallbacks): Promise<void>;

  disconnect(): Promise<void>; // Closes browser but keeps session (can reconnect without QR)

  logout(): Promise<void>; // Logs out and clears session data (requires QR scan again)

  destroy(): Promise<void>;

  // Force-kill THIS engine's own resources immediately (e.g. SIGKILL a wedged Chromium for a stuck
  // session), then best-effort graceful teardown — used to recover a session that destroy() can't.
  // Each adapter kills only its own resources (never a process-wide pkill).
  forceDestroy(): Promise<void>;

  getStatus(): EngineStatus;

  /**
   * Active liveness probe: performs a real round-trip against the engine's connection and
   * resolves true only when the session is genuinely alive. Implementations must treat probe
   * failure/timeout as "dead" — a wedged connection can keep reporting READY (cached status),
   * so getStatus() alone is not proof of life. Optional: engines whose transport already
   * self-detects death (e.g. Baileys keepalive emits a close event within ~35s) may return a
   * cheap local check. Polled periodically by the session watchdog.
   */
  probeLiveness?(): Promise<boolean>;

  getQRCode(): string | null;

  /**
   * Request an 8-char pairing code to link via phone number instead of scanning the QR. Only valid while
   * the engine is QR_READY; both adapters throw EngineNotReadyError (409) in any other status.
   */
  requestPairingCode(phoneNumber: string): Promise<string>;

  getPhoneNumber(): string | null;

  getPushName(): string | null;
}

/**
 * Outbound messaging: every member that composes a NEW message into a chat — text, media,
 * location, contact card, sticker, poll — plus reply and forward, which are sends that quote or
 * re-route existing content.
 */
export interface MessagingCapability {
  /**
   * Send text.
   *
   * `linkPreview: false` suppresses the URL preview on BOTH engines. Otherwise the two differ:
   * whatsapp-web.js builds one in-page by default, while on Baileys a preview is OPT-IN — only
   * `linkPreview: true` produces one, because generating it is a blocking outbound fetch per URL.
   */
  sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    options?: { linkPreview?: boolean; customPreview?: CustomLinkPreview } & Quotable,
  ): Promise<MessageResult>;

  sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult>;

  sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult>;

  sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult>;

  /**
   * Reply to a message, quoting it. `mentions` tags participants exactly as on the send routes: the
   * text must also carry the matching `@<number>` token for WhatsApp to render the tag.
   */
  replyToMessage(chatId: string, quotedMsgId: string, text: string, mentions?: string[]): Promise<MessageResult>;

  forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult>;
}

/**
 * Operations on messages that already exist: delete, edit, star, pin, and the reaction surface.
 *
 * votePoll lives here rather than with the poll send in MessagingCapability: it mutates an
 * existing poll message (the same shape of act as reactToMessage), it does not compose one.
 */
export interface MessageOperationsCapability {
  reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void>;

  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]>;

  deleteMessage(chatId: string, messageId: string, forEveryone?: boolean): Promise<void>;

  /**
   * Edit the body of a text message. Only the account's OWN messages can be edited; engines reject
   * non-text or foreign messages at their own layer — the engine's error is surfaced as-is.
   *
   * `mentions` re-applies participant tags to the new body. An edit REPLACES the message content, so
   * omitting it drops whatever tags the original carried rather than preserving them.
   */
  editMessage(chatId: string, messageId: string, body: string, mentions?: string[]): Promise<MessageResult>;

  /**
   * Star (bookmark) a message, or remove its star. Starring is a private, account-local marker —
   * it is not visible to the other party and has no group-admin restriction.
   */
  starMessage(chatId: string, messageId: string, star: boolean): Promise<void>;

  /**
   * Cast a vote on a poll. `options` are the option TEXTS, not ids: whatsapp-web.js matches by name
   * (`Message.js:1027-1031`), and no engine surfaces a stable per-option id through this interface,
   * so a caller has nothing else to name an option by. Pass every option that should end up
   * selected — the list replaces the current selection rather than adding to it, and an empty array
   * clears the vote.
   *
   * A poll whose options include duplicate texts will select ALL matching options; WhatsApp permits
   * duplicates, and the name is the only handle available.
   */
  votePoll(chatId: string, pollMessageId: string, options: string[]): Promise<void>;

  /**
   * Pin a message in its chat for a bounded window. WhatsApp only recognises three durations —
   * 86400 (24h), 604800 (7d), 2592000 (30d) — so `durationSeconds` must be one of those; it is
   * required rather than defaulted here so neither adapter has to invent a value. In a group only
   * admins may pin; the engines surface their own refusal.
   */
  pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void>;

  /** Remove a message's pin. Unpinning takes no duration — an existing pin's window is irrelevant. */
  unpinMessage(chatId: string, messageId: string): Promise<void>;
}

/**
 * Reading a chat's stored messages. Kept apart from the chat-management slice because this is
 * the engine's only media-bearing read path — the media budget parameters are a download
 * concern no other member shares.
 */
export interface ChatHistoryCapability {
  /**
   * Read a chat's recent messages, newest first. When `includeMedia` downloads blobs, an optional
   * `mediaMaxBytes` tightens the declared-size pre-gate below the global MEDIA_DOWNLOAD_MAX_BYTES —
   * the status seed uses it to skip downloads the store would discard as over-cap anyway.
   * Inlined media is additionally bounded in aggregate (CHAT_HISTORY_MEDIA_BUDGET_BYTES): once the
   * running base64 total crosses the budget, later media messages carry the `omitted` marker instead
   * of a download. An optional `signal` (e.g. client disconnect) stops the read loop early; the
   * messages collected so far are returned.
   */
  getChatHistory(
    chatId: string,
    limit?: number,
    includeMedia?: boolean,
    mediaMaxBytes?: number,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]>;
}

/**
 * Contacts and the account's addressbook: reads, number/identity resolution, the blocklist, and
 * addressbook writes.
 *
 * getProfilePicture sits here rather than with profiles: it reads any party's picture (a group
 * JID included — see setGroupPicture), and its consumer domain is contact data.
 */
export interface ContactCapability {
  getContacts(): Promise<Contact[]>;

  getContactById(contactId: string): Promise<Contact | null>;

  checkNumberExists(number: string): Promise<boolean>;

  /**
   * Resolve a phone number to its canonical chat id in the neutral dialect (`<phone>@c.us`), or null
   * if the number is not registered. The engine owns the JID scheme and returns it already neutralized,
   * so the value is engine-agnostic and round-trips back to a send on any engine.
   */
  getNumberId(number: string): Promise<string | null>;

  /**
   * Best-effort resolution of a contact id to a phone number (MSISDN digits), or `null` when the
   * engine cannot map it (e.g. a privacy `@lid` the account has never seen). The contact id is the
   * engine's native scheme; the adapter decides how to resolve it.
   */
  resolveContactPhone(contactId: string): Promise<string | null>;

  getProfilePicture(contactId: string): Promise<string | null>;

  blockContact(contactId: string): Promise<void>;

  unblockContact(contactId: string): Promise<void>;

  /**
   * Neutral ids of the contacts this account has blocked — the read half of block/unblockContact.
   * Ids only: whatsapp-web.js resolves full Contact models, but Baileys' blocklist query answers
   * bare jids, and inventing the other fields on one engine would make the two engines claim
   * different things about the same account.
   */
  getBlockedContacts(): Promise<string[]>;

  /**
   * Save a contact to the account's addressbook, or edit an existing entry. `contactId` is a
   * neutral JID; whatsapp-web.js addresses the entry by phone number and Baileys by JID, so the
   * adapters convert. An empty `lastName` is normal — WhatsApp stores single-name contacts.
   */
  upsertContact(contactId: string, firstName: string, lastName?: string): Promise<void>;

  /** Remove a contact from the account's addressbook. Does not block or delete the chat. */
  deleteContact(contactId: string): Promise<void>;
}

/** Groups: reads, membership writes, settings mutations, invites, and join approvals. */
export interface GroupCapability {
  getGroups(): Promise<Group[]>;

  getGroupInfo(groupId: string): Promise<GroupInfo | null>;

  createGroup(name: string, participants: string[]): Promise<Group>;

  /**
   * Membership writes resolve one {@link ParticipantOperationResult} per participant, so a partial
   * refusal (one invite-only number among several added) is visible instead of being flattened into
   * a blanket success. They THROW only when the operation failed for every requested participant —
   * e.g. the account lacks admin rights — or the batch itself was refused.
   */
  addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]>;

  removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]>;

  promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]>;

  demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]>;

  leaveGroup(groupId: string): Promise<void>;

  setGroupSubject(groupId: string, subject: string): Promise<void>;

  setGroupDescription(groupId: string, description: string): Promise<void>;

  getGroupInviteCode(groupId: string): Promise<string>;

  revokeGroupInviteCode(groupId: string): Promise<string>;

  /**
   * Join a group via an invite code (the token from a `https://chat.whatsapp.com/<code>` link).
   * Resolves with the joined group's neutral id (`<id>@g.us`).
   */
  joinGroupViaInviteCode(inviteCode: string): Promise<string>;

  /**
   * What an invite code discloses about a group, without joining it. Read-only: nothing about the
   * account's membership changes, which is what makes it safe to call on an untrusted code.
   */
  getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo>;

  /** Set the "only admins can send messages" group setting (WhatsApp announce). */
  setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void>;

  /** Set the "only admins can edit group info" group setting (WhatsApp locked/restrict). */
  setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void>;

  /**
   * Set the group's picture. Requires admin rights on both engines; the engines report a refusal
   * differently, so the adapters normalise it. Reading the current picture needs no dedicated
   * method — `getProfilePicture` accepts a group JID.
   */
  setGroupPicture(groupId: string, media: MediaInput): Promise<void>;

  /** Remove the group's picture. */
  deleteGroupPicture(groupId: string): Promise<void>;

  /** Set who may add participants to the group. */
  setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void>;

  /**
   * Set the group's disappearing-messages timer in seconds; 0 disables it.
   * Known values: 86400 (24h), 604800 (7d), 7776000 (90d).
   */
  setGroupEphemeral(groupId: string, durationSec: number): Promise<void>;

  /**
   * Pending join requests for a group with join-approval turned on. Admin-only on both engines;
   * a non-admin's read is refused by the engine and surfaced as-is.
   */
  getGroupMembershipRequests(groupId: string): Promise<GroupMembershipRequest[]>;

  /**
   * Approve pending join requests — the named participants, or EVERY pending request when
   * `participants` is omitted. Per-participant outcomes follow the membership-write contract
   * (see addParticipants); the all-failed/no-outcome guards apply only when participants were
   * NAMED — approving an empty queue is a no-op that resolves [].
   */
  approveGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]>;

  /** Reject pending join requests; same contract as approveGroupMembershipRequests. */
  rejectGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]>;
}

/**
 * Calls: rejecting a ringing call and generating call links. Call EVENTS arrive through
 * EngineEventCallbacks (onCall / onCallOutcome), not through this slice.
 */
export interface CallCapability {
  /**
   * Reject an incoming call. Only a currently-ringing call can be rejected: the adapter keeps the
   * engine's live call handle (keyed by the `callId` from {@link IncomingCallEvent}) for the
   * ringing window, and an unknown or expired callId fails with a not-found error (HTTP 404).
   */
  rejectCall(callId: string): Promise<void>;

  /**
   * Generate a shareable WhatsApp call link, returning the finished `https://call.whatsapp.com/…`
   * URL. `startTime` is an absolute epoch-MILLISECONDS timestamp; both engines take seconds on the
   * wire and each adapter converts.
   *
   * The engines return different things and the adapters reconcile them: whatsapp-web.js resolves
   * the finished link (or `''` on failure), Baileys resolves only the bare token and the adapter
   * assembles it behind the library's own prefix. A WhatsApp-side failure throws rather than
   * returning an empty or prefix-only link, which would look like a working link and is not one.
   */
  createCallLink(type: CallLinkType, startTime: number): Promise<string>;
}

/**
 * The account's OWN profile: display name, about text, and picture. Distinct from
 * ContactCapability, which reads and writes other parties.
 */
export interface ProfileCapability {
  /** Set the account's display name. */
  setProfileName(name: string): Promise<void>;

  /** Set the account's "about" / status text. */
  setProfileStatus(status: string): Promise<void>;

  /** Set the account's profile picture (a URL payload is fetched server-side). */
  setProfilePicture(media: MediaInput): Promise<void>;

  /**
   * Remove the account's own profile picture. Resolves when the removal is acknowledged; deleting a
   * picture that is not there is a no-op rather than an error, so the call is idempotent.
   *
   * Only whatsapp-web.js can report a refusal, and only as an explicit `false` — its page helper
   * also returns `undefined` when it did not attempt the delete at all, which is NOT a refusal.
   * Baileys resolves void and has no refusal signal, so it reports success for any acknowledged
   * write.
   */
  deleteProfilePicture(): Promise<void>;
}

/**
 * Labels (WhatsApp Business): label reads and writes, and the label-to-chat assignment surface.
 * A non-business account has no labels at all.
 */
export interface LabelCapability {
  getLabels(): Promise<Label[]>;

  getLabelById(labelId: string): Promise<Label | null>;

  getChatLabels(chatId: string): Promise<Label[]>;

  addLabelToChat(chatId: string, labelId: string): Promise<void>;

  /**
   * Create or update a label, keyed on `label.id`. One operation, not two: the engines express both
   * through a single app-state write, and which one happens depends on whether the id already
   * exists. Only fields that are set are changed.
   */
  upsertLabel(label: LabelInput): Promise<void>;

  /** Delete a label. It disappears from every chat it was on. */
  deleteLabel(labelId: string): Promise<void>;

  /** Every chat carrying a label. */
  getChatsByLabel(labelId: string): Promise<ChatSummary[]>;

  removeLabelFromChat(chatId: string, labelId: string): Promise<void>;
}

/** Channels/newsletters: subscription, reads, and the owner-only administration writes. */
export interface ChannelCapability {
  getSubscribedChannels(): Promise<Channel[]>;

  getChannelById(channelId: string): Promise<Channel | null>;

  subscribeToChannel(inviteCode: string): Promise<Channel>;

  unsubscribeFromChannel(channelId: string): Promise<void>;

  getChannelMessages(channelId: string, limit?: number): Promise<ChannelMessage[]>;

  /**
   * Create a channel and return it. The account becomes its owner, which is what makes deleting it
   * possible later — neither engine can delete a channel it does not own.
   */
  createChannel(name: string, description?: string): Promise<Channel>;

  /** Delete a channel this account owns. Irreversible, and its subscribers lose it. */
  deleteChannel(channelId: string): Promise<void>;

  /** Mute or unmute a channel's notifications for this account. Does not affect subscription. */
  muteChannel(channelId: string, mute: boolean): Promise<void>;

  /**
   * Demote a channel admin back to a plain subscriber. Requires this account to own the channel.
   *
   * There is deliberately no promote counterpart: neither library has one — Baileys exposes no
   * `newsletterPromote` and whatsapp-web.js no `promoteChannelAdmin` — so an admin is promoted from
   * the WhatsApp app and can then be demoted here.
   */
  demoteChannelAdmin(channelId: string, userId: string): Promise<void>;

  /**
   * Hand a channel this account owns to a new owner. **Irreversible** — the account stops being the
   * owner and cannot take it back through this API.
   *
   * The whatsapp-web.js option to also dismiss yourself as admin in the same call is not exposed:
   * the page function it relies on no longer exists, and it sits inside a branch that swallows its
   * own errors, so it would fail silently rather than refusing.
   */
  transferChannelOwnership(channelId: string, newOwnerId: string): Promise<void>;
}

/** Status/stories: reading contacts' statuses and posting or deleting the account's own. */
export interface StatusCapability {
  getContactStatuses(): Promise<Status[]>;

  getContactStatus(contactId: string): Promise<Status[]>;

  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult>;

  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;

  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;

  /**
   * Post an audio status as a voice note. WhatsApp plays a status voice note only for Ogg/Opus, and
   * neither engine transcodes — the media conversion endpoints exist to produce it.
   */
  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;

  deleteStatus(statusId: string): Promise<void>;
}

/**
 * Catalog (WhatsApp Business): catalog and product reads. sendProduct and sendCatalog stay here
 * rather than in MessagingCapability — they ship a catalog entity into a chat, and their consumer
 * is the commerce domain, so a messaging-only dependency need not carry them.
 */
export interface CatalogCapability {
  getCatalog(): Promise<Catalog | null>;

  getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts>;

  getProduct(productId: string): Promise<Product | null>;

  sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult>;

  sendCatalog(chatId: string, body?: string): Promise<MessageResult>;
}

/**
 * Chat-list management: enumeration and per-chat flags (seen, unread, archive, pin, mute,
 * clear). These operate on the chat itself; pinning a message INSIDE a chat is
 * MessageOperationsCapability.pinMessage.
 */
export interface ChatCapability {
  getChats(): Promise<ChatSummary[]>;

  /**
   * `messageIds` names exactly which messages to acknowledge. Engines that acknowledge per
   * message (Baileys) need it to mark a burst, or anything at all after a restart; engines with a
   * chat-level receipt (whatsapp-web.js) ignore it.
   */
  sendSeen(chatId: string, messageIds?: string[]): Promise<boolean>;

  markUnread(chatId: string): Promise<boolean>;

  deleteChat(chatId: string): Promise<boolean>;

  /**
   * Archive or unarchive a chat. Resolves false when the engine cannot act — on Baileys the
   * archive is an app-state modification keyed to the chat's last message, so a chat with no known
   * history cannot be archived at all. Same shape as deleteChat/markUnread, which share that limit.
   */
  archiveChat(chatId: string, archive: boolean): Promise<boolean>;

  /**
   * Pin or unpin a chat at the top of the chat list. Chat-level — distinct from `pinMessage`, which
   * pins a message inside a chat.
   *
   * Resolves false only when the engine DECLINED, and only one direction can: WhatsApp allows at
   * most three pinned chats, and whatsapp-web.js reports the refusal rather than silently dropping
   * it. Unpinning always resolves true, and Baileys always resolves true in both directions — it
   * writes an app-state patch and WhatsApp reports nothing back, so it cannot see the cap. Unlike
   * archiveChat the patch carries no `lastMessages`, so a chat with no known history pins fine.
   */
  pinChat(chatId: string, pin: boolean): Promise<boolean>;

  /**
   * Mute or unmute a chat's notifications. `muteUntil` is an absolute epoch-MILLISECONDS timestamp
   * the mute expires at; `null` unmutes now. To mute indefinitely, pass a far-future timestamp —
   * neither engine exposes a portable "forever" sentinel (whatsapp-web.js uses -1 internally,
   * Baileys has none), so the contract keeps a single well-defined shape instead.
   *
   * Milliseconds is measured, not inferred. WhatsApp's app-state `MuteAction.muteEndTimestamp` is
   * unsuffixed while the proto spells other millisecond fields `…Ms`, which reads as seconds and is
   * wrong: sending an epoch-seconds value live left the chat unmuted (the instant had already
   * passed in 1970), and the same instant sent in milliseconds muted it to the expected minute.
   * Getting this backwards is silent — the send still answers 200 and the mute simply never applies,
   * or lands tens of thousands of years out and reads as permanent.
   *
   * Unlike archiveChat/clearChatMessages/deleteChat this has no "engine declined" outcome: the
   * Baileys `mute` app-state modification carries no `lastMessages`, so a chat with no known
   * history mutes like any other. That is why it resolves void rather than boolean.
   */
  muteChat(chatId: string, muteUntil: number | null): Promise<void>;

  /**
   * Delete every message in a chat while keeping the chat itself in the list. Resolves false when
   * the engine cannot act — an unknown chat on whatsapp-web.js, or (as with archiveChat) a chat
   * with no known history on Baileys, whose clear is keyed to the last message.
   */
  clearChatMessages(chatId: string): Promise<boolean>;
}

/**
 * Presence: chat typing/recording indicators, the account's own online visibility, and presence
 * subscriptions (delivered through onPresenceUpdate).
 */
export interface PresenceCapability {
  /**
   * Send a typing/recording presence indicator to a chat, or clear it (`paused`).
   * Engine-agnostic and best-effort: engines without a presence concept should no-op.
   */
  sendChatState(chatId: string, state: ChatState): Promise<void>;

  /**
   * Publish the ACCOUNT's own global presence: `true` = appear online, `false` = appear offline.
   * A linked device that announces itself online routes notifications away from the phone, so a
   * headless bot that never goes offline suppresses the phone's own alerts — which is why this is
   * NOT best-effort, unlike sendChatState: the caller asked for a specific visibility, and a
   * swallowed failure would leave the account silently online. The setting belongs to the
   * connection and resets on reconnect (Baileys re-announces per its `markOnlineOnConnect`
   * socket option), so callers re-issue it after a reconnect.
   */
  setOnlinePresence(available: boolean): Promise<void>;

  /**
   * Ask WhatsApp to start reporting a chat's presence, delivered through `onPresenceUpdate`.
   *
   * Deliberately per chat rather than a blanket subscribe-all: WhatsApp emits a presence update on
   * every transition — each time someone starts and stops typing — so subscribing to everything
   * turns an idle account into a firehose. The subscription lasts for the life of the connection and
   * has to be re-established after a reconnect.
   *
   * There is no matching read: presence cannot be queried, only received, which is why the gateway
   * serves the last reported state rather than fetching it.
   */
  subscribeToPresence(chatId: string): Promise<void>;
}

/**
 * The complete engine contract: every capability slice above, composed. Nothing is declared here
 * directly — a member belongs to the slice its consumer domain forms, so an engine-wide member
 * would mean a domain that has no other surface. Adapters implement this union unchanged.
 */
export interface IWhatsAppEngine
  extends
    SessionLifecycleCapability,
    MessagingCapability,
    MessageOperationsCapability,
    ChatHistoryCapability,
    ContactCapability,
    GroupCapability,
    CallCapability,
    ProfileCapability,
    LabelCapability,
    ChannelCapability,
    StatusCapability,
    CatalogCapability,
    ChatCapability,
    PresenceCapability {}
