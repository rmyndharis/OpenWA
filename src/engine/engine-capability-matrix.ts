/**
 * Committed engine capability matrix: for each `IWhatsAppEngine` method, the REAL availability on
 * each adapter — `wwjs` = whatsapp-web.js (the default engine), `baileys` = the browser-free
 * alternative.
 *
 * Two fields tell the story:
 *  - `status`: 'supported' (the capability genuinely works end-to-end) or 'not-available' (the method
 *    either throws `EngineNotSupportedError`/`ChannelMediaNotSupportedError` at the adapter boundary
 *    → HTTP 501, OR the adapter claims support but the underlying library cannot deliver — a
 *    phantom-support case surfaced by source verification, e.g. wwjs catalog methods that log
 *    "not implemented" and return null/[] without throwing).
 *  - `rootCause` (present only when `not-available`): WHY it is not available, so a contributor knows
 *    exactly where to start. Three values:
 *      'adapter-gap'        — the underlying library HAS the capability; only the OpenWA adapter
 *                             wiring is missing. FIXABLE in this repo (a PR that calls the library
 *                             symbol the evidence points at).
 *      'library-limitation' — the underlying library exposes NO first-class symbol for this op. Not
 *                             fixable without a raw-proto/fork effort or an event-cache hack.
 *      'uncertain'          — source trace was inconclusive; needs a live spike.
 *
 * `evidence` (present only when at least one adapter is `not-available`) cites the library symbol(s)
 * that were inspected, so an engineer can open the exact file and start wiring immediately.
 *
 * This is a SNAPSHOT. `engine-parity.spec.ts` regenerates the supported/not-available *classification*
 * from the live adapter method bodies (a method is "not-available" if it throws
 * EngineNotSupportedError / ChannelMediaNotSupportedError) and fails on drift, so a parity change
 * cannot land without deliberately updating this matrix (and docs/engine-capability-matrix.md). The
 * `rootCause`/`evidence` fields are hand-curated, source-traced annotations; they are NOT regenerated
 * by the spec and are updated by hand as adapters are wired or libraries change.
 *
 * NOTE on phantom support: the drift gate's throw-heuristic cannot see adapter methods that silently
 * stub (return null/[] + a warn log) without throwing. The matrix BELOW is the source-of-truth: five
 * wwjs entries (getCatalog/getProducts/getProduct/getContactStatus/getContactStatuses) are marked
 * `not-available` here even though their adapter bodies do not throw — because the underlying library
 * either has no API (catalog) or the adapter stubs instead of calling the available symbol (status
 * read). If the drift gate is extended to assert against this matrix, it must consult `status`, not
 * just the throw pattern, for these rows (or the adapter stubs must start throwing).
 */
export type CapabilityStatus = 'supported' | 'not-available';
export type RootCause = 'adapter-gap' | 'library-limitation' | 'uncertain';

export interface AdapterCapability {
  status: CapabilityStatus;
  /** Present only when `status === 'not-available'`. */
  rootCause?: RootCause;
}

export interface MethodCapability {
  wwjs: AdapterCapability;
  baileys: AdapterCapability;
  /** Cited library symbols (baileys; wwjs). Present only when at least one adapter is not-available. */
  evidence?: string;
}

export const ENGINE_CAPABILITY_MATRIX: Record<string, MethodCapability> = {
  addLabelToChat: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  addParticipants: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  blockContact: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  checkNumberExists: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  createGroup: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteChat: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteStatus: {
    wwjs: { status: 'not-available', rootCause: 'adapter-gap' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.revokeStatusMessage (index.d.ts:139; Client.js:2795 WAWebRevokeStatusAction.sendStatusRevokeMsgAction) — adapter throws instead of calling it; baileys sendMessage(status@broadcast,{delete}) @baileys.adapter.ts:913 (self-described empirically-unverified revoke shape)',
  },
  demoteParticipants: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  destroy: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  disconnect: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  forceDestroy: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  forwardMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getCatalog: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys Socket/business.d.ts:7 getCatalog({jid,limit,cursor}) + getCollections (business.d.ts:11) — adapter unwired (returns Product[]+cursor, not Catalog metadata; medium-confidence shape synthesis); wwjs index.d.ts has NO Client.getCatalog (0 hits), adapter stubs to null @whatsapp-web-js.adapter.ts:1770',
  },
  getChannelById: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys Socket/newsletter.d.ts:9 newsletterMetadata(type,key) → NewsletterMetadata (Mex.d.ts:115) — adapter unwired; wwjs resolves via getChannels() find-by-id @whatsapp-web-js.adapter.ts:1562',
  },
  getChannelMessages: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys Socket/newsletter.d.ts:19 newsletterFetchMessages(jid,count,since,after) returns RAW BinaryNode of <message_updates> (newsletter.js:149) — adapter unwired AND no exposed library parser (BinaryNode→ChannelMessage mapping is the work); wwjs Channel.fetchMessages (Channel.js:327)',
  },
  getChatHistory: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys only fetchMessageHistory(count,oldestKey,oldestTs) (Socket/business.d.ts:25) returns a sync-token string; messages arrive later via messaging-history.set event — no synchronous per-chat fetchMessages; wwjs Chat.fetchMessages (Chat.js)',
  },
  getChatLabels: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys no getChatLabels in lib/**/*.d.ts; Types/LabelAssociation.d.ts defines ChatLabelAssociation but no query fn (only addChatLabel/removeChatLabel writes @chats.d.ts:70-71); wwjs Client.getChatLabels (Client.js:2838)',
  },
  getChats: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getContactById: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getContactStatus: {
    wwjs: { status: 'not-available', rootCause: 'adapter-gap' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys fetchStatus (Socket/chats.d.ts:42 via USyncStatusProtocol) = about/profile text only, NOT 24h stories — no story getter in lib; wwjs Client.getBroadcastById (index.d.ts:136; Client.js:2771) EXISTS but adapter stubs to [] @whatsapp-web-js.adapter.ts:1740',
  },
  getContactStatuses: {
    wwjs: { status: 'not-available', rootCause: 'adapter-gap' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys fetchStatus = about text only; no story enumerate in lib; wwjs Client.getBroadcasts (index.d.ts:133; Client.js:2759 WWebJS.getAllStatuses) EXISTS but adapter stubs to [] @whatsapp-web-js.adapter.ts:1732',
  },
  getContacts: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getGroupInfo: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getGroupInviteCode: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getGroups: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getLabelById: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys no getLabel/getLabelById in lib/**/*.d.ts (Types/Label.d.ts has only Label interface + LabelColor enum + LabelActionBody); derivable only from an app-state-sync label cache; wwjs Client.getLabelById (Client.js:2825)',
  },
  getLabels: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys no getLabel/fetchLabel in lib/**/*.d.ts; chats.d.ts:69-73 + business.d.ts:162-166 expose ONLY writes; derivable only from an app-state-sync event cache; wwjs Client.getLabels (Client.js:2747)',
  },
  getMessageReactions: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys no getReactions/fetchReactions; reactions exist only as event-augmented WAMessage.reactions (proto.IReaction @WAProto/index.d.ts:10623) via messages.reaction event; adapter does not persist them into its store; wwjs Message.getReactions (Message.js)',
  },
  getNumberId: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getPhoneNumber: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getProduct: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys only getCatalog (Socket/business.d.ts:7); getProduct = getCatalog then find-by-id (compose-and-filter, loads whole page; medium-confidence); wwjs no Client.getProduct — only page-internal getProductMetadata (Utils.js:1253), not a public Client fn; adapter stubs to null @whatsapp-web-js.adapter.ts:1786',
  },
  getProducts: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys Socket/business.d.ts:7 getCatalog({jid,limit,cursor}) → {products, nextPageCursor} — adapter unwired; wwjs no Client.getProducts in index.d.ts (0 hits); adapter stubs to empty @whatsapp-web-js.adapter.ts:1777',
  },
  getProfilePicture: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getPushName: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getQRCode: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getSubscribedChannels: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys no enumerate-newsletters fn; all 23 Socket/newsletter.d.ts exports are per-jid (newsletterMetadata requires a key; newsletterSubscribers returns the count of ONE). Only the newsletter EVENT surfaces jids opportunistically (incremental, not list-all); wwjs Client.getChannels (Client.js:1680)',
  },
  initialize: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  leaveGroup: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  logout: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  markUnread: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  postImageStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  postTextStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  postVideoStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  promoteParticipants: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  reactToMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  removeLabelFromChat: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  removeParticipants: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  replyToMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  requestPairingCode: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  resolveContactPhone: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  revokeGroupInviteCode: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendAudioMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendCatalog: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys AnyMessageContent (Types/Message.d.ts:166-210) has no catalog key — only {product} single-product + product_catalog_edit/add/delete CRUD (Socket/business.js:294-362); wwjs no Client.sendCatalog in index.d.ts (0 hits)',
  },
  sendChatState: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendContactMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendDocumentMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendImageMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendLocationMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendPollMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendProduct: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys AnyRegularMessageContent {product: WASendableProduct} (Types/Message.d.ts:203) built in messages.js:397 — adapter unwired (2-step: getCatalog lookup for image/title/price THEN sendMessage); wwjs no Client.sendProduct — Product/Order are inbound-only parsers',
  },
  sendSeen: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendStickerMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendTextMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendVideoMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  setGroupDescription: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  setGroupSubject: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  subscribeToChannel: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys Socket/newsletter.d.ts:10 newsletterFollow(jid) needs a jid — bridge via newsletterMetadata("invite",code).id (2-step); adapter unwired; wwjs Client.subscribeToChannel (Client.js:2529)',
  },
  unblockContact: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  unsubscribeFromChannel: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'adapter-gap' },
    evidence:
      'baileys Socket/newsletter.d.ts:11 newsletterUnfollow(jid) — channelId is the @newsletter jid, maps 1:1; adapter unwired; wwjs Client.unsubscribeFromChannel (Client.js:2550)',
  },
};
