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
 * `evidence` cites the library symbol(s) that were inspected, so an engineer can open the exact file
 * and start wiring immediately. REQUIRED when at least one adapter is `not-available`; may also
 * annotate a newly-wired `supported` row with the symbols it now calls.
 *
 * This is a SNAPSHOT. `engine-parity.spec.ts` enforces exact matrix-key↔interface-method correspondence
 * and the throw-invariants it can observe in live adapter method bodies. It does not read the operator
 * documentation and cannot classify non-throwing phantom stubs. The `status`, `rootCause`, and
 * `evidence` fields therefore remain hand-curated, source-traced annotations that must be reviewed as
 * adapters are wired or libraries change.
 *
 * NOTE on phantom support: the drift gate's throw-heuristic cannot see adapter methods that silently
 * stub (return null/[] + a warn log) without throwing. The wwjs catalog rows (getCatalog/getProducts/
 * getProduct) used to be the live example — marked `not-available` here while their adapter bodies
 * did not throw — until the adapter stubs were replaced with explicit EngineNotSupportedError 501s,
 * so the throw-scan now sees them like every other unavailable row. If a future row must stay
 * non-throwing while `not-available`, the gate cannot verify it: keep it hand-tracked here (or make
 * the adapter throw). getContactStatus/getContactStatuses were on this list until #714 wired them on
 * whatsapp-web.js; their rows say `supported` and the adapter really does read stories, so they no
 * longer belong here.
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
  /** Cited library symbols (baileys; wwjs). Required when at least one adapter is not-available. */
  evidence?: string;
}

export const ENGINE_CAPABILITY_MATRIX: Record<string, MethodCapability> = {
  addLabelToChat: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  upsertLabel: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'supported' },
    evidence:
      "baileys addLabel(jid, LabelActionBody{id,name?,color?,deleted?}) (Socket/chats.d.ts:69) emits one `label_edit` app-state patch indexed by ['label_edit', id] (Utils/chat-utils.js:579-593), so create and update are the same write; whatsapp-web.js 1.34.7 exposes getLabels/getLabelById/getChatLabels/getChatsByLabelId/addOrRemoveLabels (index.d.ts:129-154) and nothing that edits a label itself",
  },
  deleteLabel: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'supported' },
    evidence:
      'baileys the same addLabel write with deleted:true (LabelActionBody.deleted, Types/Label.d.ts:13-22 → labelEditAction.deleted, Utils/chat-utils.js:586); whatsapp-web.js has no label delete',
  },
  getChatsByLabel: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      "wwjs Client.getChatsByLabelId(labelId) (index.d.ts:153-154); baileys exposes label WRITES only (Socket/chats.d.ts:69-73 addLabel/addChatLabel/removeChatLabel) with no query at all — Types/Label.d.ts is types-only, so listing a label's chats needs an app-state cache fed by the label-association sync events",
  },
  addParticipants: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.addParticipants → per-participant {code,message} object, or a reason STRING on batch refusal (index.d.ts:2184; GroupChat.js:78-264) — both mapped at the adapter; baileys groupParticipantsUpdate(jid,pids,'add') → per-jid [{status:'200'|error}] (Socket/groups.js:140-156); per-participant results surface on the HTTP `results` field, a total refusal throws",
  },
  archiveChat: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs Client.archiveChat(chatId)/unarchiveChat(chatId) → Promise<boolean> (index.d.ts:46,328) — the CLIENT methods, not Chat.archive(), which resolves void; baileys chatModify({archive,lastMessages}, jid) (Types/Chat.d.ts:63-66) needs the chat's last message, so a chat with no known history resolves false rather than throwing",
  },
  blockContact: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  checkNumberExists: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  clearChatMessages: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Chat.clearMessages() → boolean (index.d.ts:1896); the injected sendClearChat returns false for an unknown chat (Injected/Utils.js:1192-1199); baileys chatModify({clear:true,lastMessages}, jid) (Types/Chat.d.ts:75-78) — same last-message requirement as archiveChat, so a chat with no known history resolves false',
  },
  createGroup: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteChat: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteContact: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.deleteAddressbookContact(phoneNumber) → void (index.d.ts:320; the parameter is misspelled `honeNumber` upstream, positional so harmless); baileys removeContact(jid) (Socket/chats.d.ts:67). wwjs addresses the entry by PHONE, baileys by JID — the adapter converts',
  },
  deleteGroupPicture: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs GroupChat.deletePicture() → boolean (index.d.ts:2249; false → adapter throws EngineRefusedError); baileys removeProfilePicture(groupJid) (Socket/groups.d.ts:83) — the same call used for the own account, addressed at the group JID',
  },
  deleteMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  demoteParticipants: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.demoteParticipants → batch {status:200} only (index.d.ts:2195 ChangeParticipantsPermissions; GroupChat.js:343-374) — a non-200 now throws at the adapter; baileys groupParticipantsUpdate(jid,pids,'demote') → per-jid [{status}] (Socket/groups.js:140-156)",
  },
  destroy: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  disconnect: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  editMessage: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Message.edit(content,options?) (index.d.ts:1362; MessageEditOptions:1600); baileys Editable.edit?: WAMessageKey on the text content variant (Types/Message.d.ts:86, AnyRegularMessageContent:168) via sendMessage(jid,{text,edit:key})',
  },
  forceDestroy: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  forwardMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getCatalog: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'supported' },
    evidence:
      'baileys getCollections(jid) (Socket/business.d.ts:11) → first collection synthesized into Catalog metadata at BaileysCatalog (adapters/baileys-catalog.ts; #905); wwjs index.d.ts has NO Client.getCatalog (0 hits) — adapter throws EngineNotSupportedError',
  },
  createChannel: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  deleteChannel: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  muteChannel: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getGroupJoinInfo: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getChannelById: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
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
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys fetchStatus (Socket/chats.d.ts:42 via USyncStatusProtocol) = about/profile text only, NOT 24h stories — no story getter in lib',
  },
  getContactStatuses: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence: 'baileys fetchStatus = about text only; no story enumerate in lib',
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
    baileys: { status: 'supported' },
    evidence:
      'baileys getCatalog cursor-walk then find-by-id (compose-and-filter over the full catalog; adapters/baileys-catalog.ts; #905); wwjs no Client.getProduct — only page-internal getProductMetadata (Utils.js:1253), not a public Client fn — adapter throws EngineNotSupportedError',
  },
  getProducts: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'supported' },
    evidence:
      'baileys getCatalog({jid,limit,cursor}) (Socket/business.d.ts:7) cursor-walked in full, then page/limit sliced at the adapter (adapters/baileys-catalog.ts; #905); wwjs no Client.getProducts in index.d.ts (0 hits) — adapter throws EngineNotSupportedError',
  },
  getProfilePicture: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getPushName: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getQRCode: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  getSubscribedChannels: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      'baileys no enumerate-newsletters fn; 18 of the 19 Socket/newsletter.d.ts newsletter members are per-jid (only newsletterCreate is not) (newsletterMetadata requires a key; newsletterSubscribers returns the count of ONE). Only the newsletter EVENT surfaces jids opportunistically (incremental, not list-all); wwjs Client.getChannels (Client.js:1680)',
  },
  initialize: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  joinGroupViaInviteCode: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.acceptInvite(inviteCode) → res.gid._serialized (index.d.ts:23; Client.js:1836-1844); baileys groupAcceptInvite(code) → string|undefined (Socket/groups.d.ts:25) — undefined mapped to a thrown error',
  },
  leaveGroup: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  logout: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  markUnread: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  pinMessage: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Message.pin(duration) → boolean (index.d.ts:1340); the injected helper returns false for a non-number duration and for an unknown message (Injected/Utils.js:1670-1696), so the adapter maps false → EngineRefusedError; baileys sendMessage(jid,{pin:key,type:PinInChat.Type.PIN_FOR_ALL,time}) (Types/Message.d.ts:196-201) — NOT chatModify({pin}), which pins the CHAT in the chat list',
  },
  postImageStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  postTextStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  postVideoStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  postVoiceStatus: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  promoteParticipants: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.promoteParticipants → batch {status:200} only (index.d.ts:2193 ChangeParticipantsPermissions; GroupChat.js:305-340) — a non-200 now throws at the adapter; baileys groupParticipantsUpdate(jid,pids,'promote') → per-jid [{status}] (Socket/groups.js:140-156)",
  },
  reactToMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  removeLabelFromChat: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  removeParticipants: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.removeParticipants → batch {status:200} only (index.d.ts:2189; GroupChat.js:267-298) — a non-200 now throws at the adapter instead of being discarded; baileys groupParticipantsUpdate(jid,pids,'remove') → per-jid [{status}] (Socket/groups.js:140-156)",
  },
  rejectCall: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs Call.reject() (index.d.ts:2417) on the live Call cached from the client 'call' event (index.d.ts:643); baileys rejectCall(callId, callFrom) (Socket/messages-recv.d.ts:10) with the raw `from` JID cached from the 'offer' call event (Types/Call.d.ts)",
  },
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
    baileys: { status: 'supported' },
    evidence:
      'baileys AnyRegularMessageContent {product: WASendableProduct} (Types/Message.d.ts:203) — adapter resolves the product via getCatalog then sends the snapshot with businessOwnerJid=self (adapters/baileys-messaging.ts; #905); wwjs no Client.sendProduct — Product/Order are inbound-only parsers',
  },
  sendSeen: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  subscribeToPresence: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'supported' },
    evidence:
      "baileys presenceSubscribe(toJid) (Socket/chats.d.ts:39) + the 'presence.update' event carrying a per-participant PresenceData map (Types/Events.d.ts:50-55, Types/Chat.d.ts:20-24); whatsapp-web.js 1.34.7 has only sendPresenceAvailable/sendPresenceUnavailable (index.d.ts:230,233), which publish the ACCOUNT's own presence — it exposes no subscribe and emits no presence event",
  },
  sendStickerMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendTextMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  sendVideoMessage: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  starMessage: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs Message.star()/unstar() → Promise<void> (index.d.ts:1336-1338) — void, so there is no refusal signal to map, unlike pin; baileys chatModify({star:{messages:[{id,fromMe}],star}}, jid) (Types/Chat.d.ts:83-89) — needs the stored key's fromMe, since the same id means different messages depending on direction",
  },
  setGroupDescription: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs GroupChat.setDescription(description) → boolean (index.d.ts:1984; false → adapter throws EngineRefusedError); baileys groupUpdateDescription(jid, description?) (Socket/groups.d.ts:21)',
  },
  setGroupEphemeral: {
    wwjs: { status: 'not-available', rootCause: 'library-limitation' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs 1.34.7 exposes NO ephemeral setter — 0 hits for ephemeral in index.d.ts; only a create-time messageTimer option (Client.js:2371); adapter throws EngineNotSupportedError; baileys groupToggleEphemeral(jid, ephemeralExpiration) (Socket/groups.d.ts:40)',
  },
  setGroupInfoAdminsOnly: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.setInfoAdminsOnly(adminsOnly?) (index.d.ts:2216; sets groupMetadata.restrict, GroupChat.js:544); baileys groupSettingUpdate(jid, 'locked'|'unlocked') (Socket/groups.d.ts:41)",
  },
  setGroupMemberAddMode: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.setAddMembersAdminsOnly(adminsOnly?) → boolean (index.d.ts:2205; false → adapter throws EngineRefusedError); baileys groupMemberAddMode(jid,'admin_add'|'all_member_add') (Socket/groups.d.ts:42). NOT a groupSettingUpdate option on either engine. Read side disagrees between engines and with wwjs's own types: baileys GroupMetadata.memberAddMode is a boolean where true = all_member_add (Socket/groups.js:304), while wwjs stores WhatsApp's raw strings (GroupChat.js:476) despite index.d.ts:890 declaring a boolean with the OPPOSITE sense — both are normalised to 'all'|'admins' at the adapter",
  },
  setGroupMessagesAdminsOnly: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs GroupChat.setMessagesAdminsOnly(adminsOnly?) (index.d.ts:2210; sets groupMetadata.announce, GroupChat.js:513); baileys groupSettingUpdate(jid, 'announcement'|'not_announcement') (Socket/groups.d.ts:41)",
  },
  setGroupPicture: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs GroupChat.setPicture(MessageMedia) → boolean (index.d.ts:2247) — the GroupChat method, not Client.setProfilePicture which targets the own account; baileys updateProfilePicture(groupJid, WAMediaUpload) (Socket/groups.d.ts:79)',
  },
  setGroupSubject: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs GroupChat.setSubject(newSubject) → boolean (index.d.ts:1982; false → adapter throws EngineRefusedError); baileys groupUpdateSubject(jid, subject) (Socket/groups.d.ts:20)',
  },
  setProfileName: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.setDisplayName(displayName) → boolean (index.d.ts:251; false → adapter throws); baileys updateProfileName(name) (Socket/chats.d.ts:50)',
  },
  setProfilePicture: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.setProfilePicture(MessageMedia) → boolean (index.d.ts:336; false → adapter throws); baileys updateProfilePicture(ownJid, WAMediaUpload) (Socket/chats.d.ts:44)',
  },
  setProfileStatus: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.setStatus(status) (index.d.ts:245); baileys updateProfileStatus(status) (Socket/chats.d.ts:49)',
  },
  subscribeToChannel: {
    wwjs: { status: 'not-available', rootCause: 'adapter-gap' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs Client.subscribeToChannel(channelId) → boolean (index.d.ts:71; Client.js:2533) takes a CHANNEL id, not the interface's invite code, and getChannelByInviteCode(inviteCode) (index.d.ts:103; Client.js:1707) is the invite→channel bridge — the adapter used to pass the invite code straight in and fabricate a Channel from the returned boolean; now an honest EngineNotSupportedError pending a verified two-step wiring; baileys newsletterMetadata('invite', code) + newsletterFollow (Socket/newsletter.d.ts)",
  },
  upsertContact: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      "wwjs Client.saveOrEditAddressbookContact(phoneNumber, firstName, lastName, syncToAddressbook=false) → void (index.d.ts:293-299; Client.js:3266) — lastName is positional and required, so an absent one is passed as ''; baileys addOrEditContact(jid, IContactAction{firstName,fullName,saveOnPrimaryAddressbook}) (Socket/chats.d.ts:66; WAProto IContactAction:11812)",
  },
  votePoll: {
    wwjs: { status: 'supported' },
    baileys: { status: 'not-available', rootCause: 'library-limitation' },
    evidence:
      "wwjs Message.vote(selectedOptions: string[]) (index.d.ts:1376) matches poll options BY NAME against msg.pollOptions and throws a bare STRING on a non-poll target (Message.js:1009-1040); baileys has no vote-send helper at all — only decryptPollVote for RECEIVING (Utils/messages.d.ts), so sending needs a hand-built proto.Message.PollUpdateMessage with HMAC-SHA256 vote encryption keyed by the poll creation's messageSecret",
  },
  unblockContact: { wwjs: { status: 'supported' }, baileys: { status: 'supported' } },
  unpinMessage: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Message.unpin() → boolean (index.d.ts:1342); it passes duration 0 explicitly (Message.js:738-742), so the injected non-number guard does not bite — false → EngineRefusedError; baileys sendMessage(jid,{pin:key,type:PinInChat.Type.UNPIN_FOR_ALL}) — `time` is ignored when unpinning',
  },
  unsubscribeFromChannel: {
    wwjs: { status: 'supported' },
    baileys: { status: 'supported' },
    evidence:
      'wwjs Client.unsubscribeFromChannel(channelId, options?) → boolean (index.d.ts:74; Client.js:2556; false → adapter throws EngineRefusedError); baileys newsletterUnfollow(jid) (Socket/newsletter.d.ts)',
  },
};
