import type * as BaileysLib from '@whiskeysockets/baileys';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { queryLidPhone } from './baileys-identity-query';
import type { WAMessage, WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import {
  ChatSummary,
  Contact,
  MediaInput,
  type StoredChatMessage,
  type StoredChatMessageLookup,
} from '../interfaces/whatsapp-engine.interface';
import { assertReadableImage, resolveMediaBuffer } from './baileys-messaging';
import { type createLogger } from '../../common/services/logger.service';
import { BAILEYS_QUERY_BUDGET_MS, confirmedWrite, withQueryDeadline } from './baileys-query-deadline';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { LidNotMappedError } from '../../common/errors/lid-not-mapped.error';
import { chatKind, parseWaId, toNeutralJid, userPart } from '../identity/wa-id';
import { storedKeyInChat, storedKeyInChatPersisted } from './baileys-message-mapper';
import { refusedStatusCode } from './baileys-groups';

/**
 * Contacts/profile/chats-domain operations extracted from BaileysAdapter. The adapter keeps the
 * public methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysContactsHost {
  /** This session's egress proxy URL (snapshotted at session start), or undefined when direct. */
  sessionProxyUrl(): string | undefined;
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  loadLib?(): Promise<typeof BaileysLib>;
  readonly logger: ReturnType<typeof createLogger>;
  normalizedSelfJid(): string;
  listContacts(): Contact[];
  findContact(contactId: string): Contact | null;
  resolvePhone(contactId: string): string | null;
  /** The phone the persisted lid->phone table holds for a lid, or null; read when the caches miss. */
  findPersistedLidPhone(lid: string): Promise<string | null>;
  /** Learn a lid->phone pair (written through to the persisted table). */
  recordLidMapping(lid: string, pn: string, isReported?: boolean): void;
  listChats(): ChatSummary[];
  /**
   * The chat's last known message (the handle chatModify needs), or null when none.
   * `jid` is the id the chat itself is keyed under, which for a lid-migrated contact is its lid
   * whatever id was passed.
   */
  lastMessage(chatId: string): { key: WAMessageKey; timestamp: number; jid: string } | null;
  /** The newest message the chat received, the one a read receipt can acknowledge, or null when none. */
  lastInboundMessage(chatId: string): { key: WAMessageKey; timestamp: number } | null;
  /** The `<lid>@lid` known for a 1:1 chat or a person under any spelling of it, or null (always for a group). */
  lidOf(jid: string): string | null;
  /** Every spelling of one chat the session can connect: the id, its engine form, and its lid or phone twin. */
  chatTwins(jid: string): string[];
  /**
   * When WhatsApp deleted the chat (epoch ms), under any of its spellings, or null when it did not or a
   * message has re-created it since.
   */
  chatDeletedAt(chatId: string): number | null;
  /**
   * Stored copies of the named messages, in whatever order the store returns them. Ids the store
   * has never seen are absent, so neither the length nor the order tracks the input. `undefined`
   * when the session was built without a message store.
   */
  getStoredMessages(messageIds: string[]): Promise<WAMessage[]> | undefined;
  /** Fold a neutral @c.us id to the engine @s.whatsapp.net form used as the app-state index key. */
  toEngineJid(jid: string): string;
  /** The id the chat is keyed under (its lid for a lid-migrated contact), the app-state index key. */
  chatJid(chatId: string): string;
  /** Fold an engine jid back to the neutral dialect before it crosses the engine boundary. */
  toNeutralJid(jid: string): string;
}

export class BaileysContacts {
  constructor(
    private readonly host: BaileysContactsHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /** Bound a write whose confirmation the library discards; see baileys-query-deadline.ts. */
  private confirmed<T>(work: Promise<T>, operation: string): Promise<T> {
    return confirmedWrite(work, this.queryBudgetMs, operation);
  }

  /** Post-ensureReady socket handle. */
  private sock(expected?: WASocket): WASocket {
    const socket = this.host.getSocket();
    if (expected && socket !== expected) throw new EngineNotReadyError();
    return socket;
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      // The library also accepts a timeoutMs third argument, but passing it only converts the
      // stall into a throw — which this catch would swallow into the same null. The deadline has
      // to be ours, and the catch has to let it past.
      const url = await withQueryDeadline(
        this.sock().profilePictureUrl(contactId, 'image'),
        this.queryBudgetMs,
        'WhatsApp did not answer the profile picture lookup in time',
      );
      return url ?? null;
    } catch (err) {
      // A no-picture verdict arrives as a thrown error, so this catch must keep swallowing — but a
      // query that never came back is not a verdict about the picture.
      //
      // NOTE the whatsapp-web.js adapter does the OPPOSITE on this same interface method, and
      // correctly: there the no-picture verdict is delivered as `undefined`, so every throw is a
      // failure and none of them may become null. Same neutral method, opposite error conventions
      // underneath — do not harmonise the two into a shared helper.
      if (err instanceof EngineTransportError) {
        throw err;
      }
      // Only WhatsApp's own error answer (a numeric code: 404 item-not-found, 401 not-authorized) is
      // that verdict. A socket that closed mid-lookup carries none and must not read as "no picture".
      const code = refusedStatusCode(err);
      if (code === undefined) {
        throw new EngineTransportError('WhatsApp did not answer the profile picture lookup');
      }
      // A rate limit, server timeout (408/429) or server error (5xx) is not a verdict about the picture either.
      if (code === 408 || code === 429 || code >= 500) {
        throw new EngineTransportError(`WhatsApp could not answer the profile picture lookup (code ${code})`);
      }
      this.host.logger.debug('profilePictureUrl failed; no picture or hidden', {
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // no picture set, or hidden by privacy
    }
  }

  async upsertContact(contactId: string, firstName: string, lastName = ''): Promise<void> {
    this.host.ensureReady();
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    // Baileys addresses the entry by JID, unlike whatsapp-web.js which wants a bare phone number.
    // saveOnPrimaryAddressbook stays false to match the wwjs default (syncToAddressbook=false):
    // writing through to the device addressbook is a heavier action than saving the contact.
    // Fold the neutral @c.us the API speaks to the engine @s.whatsapp.net: addOrEditContact ->
    // chatModify keys the addressbook app-state patch by the raw jid (no jidNormalizedUser, unlike
    // the send path), so a raw @c.us index would land under a key WhatsApp never reads and the
    // write would silently target nothing while the endpoint reports success.
    await this.confirmed(
      this.sock().addOrEditContact(this.host.toEngineJid(contactId), {
        firstName,
        fullName,
        saveOnPrimaryAddressbook: false,
      }),
      'the contact save',
    );
  }

  async deleteContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    // Same app-state key fold as upsertContact — a raw @c.us removal targets a phantom entry.
    await this.confirmed(this.sock().removeContact(this.host.toEngineJid(contactId)), 'the contact removal');
  }

  /**
   * `updateBlockStatus` maps the id between the phone-number and privacy-id dialects before it sends
   * anything, and refuses one it cannot map with `Boom(..., { statusCode: 400 })`: no phone number
   * for a lid, no lid for a phone number, or an id that is neither. Boom is not an HttpException, so
   * those reached the caller as an opaque `500 Internal server error` even though the request was
   * well-formed and the id is a shape this API accepts.
   *
   * Only a 400 is folded in. A dropped connection carries `DisconnectReason.connectionClosed` and the
   * write deadline throws `EngineTransportError`, and reporting either as a bad contact id would send
   * the caller after the wrong problem. whatsapp-web.js already answers `RecipientUnreachableError`
   * (400) for the same cause on the send path, so this is the parity mapping, not a new contract.
   */
  private async mapUnresolvableId<T>(contactId: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      const status = (error as { output?: { statusCode?: unknown } } | null)?.output?.statusCode;
      if (status === 400) throw new RecipientUnreachableError(contactId);
      throw error;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.mapUnresolvableId(contactId, () =>
      this.confirmed(this.sock().updateBlockStatus(contactId, 'block'), 'the block'),
    );
    this.invalidateBlocklist();
  }

  async unblockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await this.mapUnresolvableId(contactId, () =>
      this.confirmed(this.sock().updateBlockStatus(contactId, 'unblock'), 'the unblock'),
    );
    this.invalidateBlocklist();
  }

  /**
   * The read half of block/unblockContact. Bounded by our own clock: Baileys' `query()` swallows
   * its timeout, and an unanswered blocklist query would otherwise surface as an EMPTY blocklist —
   * a claim about the account sold in place of a transport failure. Wire items without a jid attr
   * are dropped rather than reported as "undefined". A contact held under both its LID and its phone
   * is two wire items that read as one id, which is listed once.
   */
  async getBlockedContacts(budgetMs: number = this.queryBudgetMs): Promise<string[]> {
    this.host.ensureReady();
    const jids = await withQueryDeadline(
      this.sock().fetchBlocklist(),
      budgetMs,
      'WhatsApp did not answer the blocklist query in time',
    );
    const ids = (jids ?? []).filter((jid): jid is string => Boolean(jid)).map(jid => this.host.toNeutralJid(jid));
    return [...new Set(ids)];
  }

  async setProfileName(name: string): Promise<void> {
    this.host.ensureReady();
    await this.confirmed(this.sock().updateProfileName(name), 'the profile name change');
  }

  async setProfileStatus(status: string): Promise<void> {
    this.host.ensureReady();
    await this.confirmed(this.sock().updateProfileStatus(status), 'the profile status change');
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    this.host.ensureReady();
    const selfJid = this.host.normalizedSelfJid();
    if (!selfJid) {
      throw new Error('cannot set the profile picture: the own JID is not known yet');
    }
    // updateProfilePicture takes a WAMediaUpload; resolveMediaBuffer covers Buffer | base64 | URL,
    // the same conversion the media sends use.
    const { data } = await resolveMediaBuffer(media, this.host.sessionProxyUrl());
    await assertReadableImage(data);
    await this.confirmed(this.sock().updateProfilePicture(selfJid, data), 'the profile picture change');
  }

  async deleteProfilePicture(): Promise<void> {
    this.host.ensureReady();
    const selfJid = this.host.normalizedSelfJid();
    if (!selfJid) {
      // Same guard as setProfilePicture: an empty jid would send the removal at nothing while the
      // endpoint reported success.
      throw new Error('cannot delete the profile picture: the own JID is not known yet');
    }
    // The same socket call `deleteGroupPicture` already uses, addressed at the account instead of a
    // group. Baileys resolves void either way, so an acknowledged write is the only signal there is.
    await this.confirmed(this.sock().removeProfilePicture(selfJid), 'the profile picture removal');
  }

  async getContacts(): Promise<Contact[]> {
    this.host.ensureReady();
    return this.withBlockedState(this.host.listContacts());
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.host.ensureReady();
    const contact = this.host.findContact(contactId);
    if (!contact) return null;
    if (
      !storedKeyInChat({ remoteJid: contact.id }, contactId, toNeutralJid) &&
      !(await this.matchesChat({ remoteJid: contact.id }, contactId))
    )
      return null;
    return (await this.withBlockedState([contact]))[0];
  }

  /**
   * Stamp the real blocklist state onto contacts the store mapped.
   *
   * The store has no socket, so its mapper defaulted `isBlocked` to a literal `false` for everyone —
   * a claim about the account, not a reading of it, while THIS session's own blocklist query returns
   * the real ids. Automation that skips blocked contacts before sending therefore messaged people the
   * account had explicitly blocked.
   *
   * A failed blocklist query degrades rather than failing the read: contacts are still useful, and
   * getBlockedContacts deliberately throws instead of returning an empty list precisely so a
   * transport failure is not sold as "nobody is blocked". The default is kept and the gap is warned
   * about, so the degradation is visible instead of silent.
   */
  private async withBlockedState(contacts: Contact[]): Promise<Contact[]> {
    if (contacts.length === 0) return contacts;
    const blocked = await this.blockedIds();
    if (!blocked) return contacts;
    return contacts.map(contact => ({ ...contact, isBlocked: blocked.has(contact.id) }));
  }

  /** Memoised blocklist. See {@link blockedIds} for why this is not queried per read. */
  private blocklistMemo?: { at: number; ids: Set<string> | null };

  /** The open query, shared by every caller that arrives while it is in flight. */
  private blocklistInFlight?: Promise<Set<string> | null>;

  /** Incremented on every block/unblock so a query started earlier cannot write a stale memo. */
  private blocklistGeneration = 0;

  /**
   * How long one blocklist answer is reused. Short enough that a block made elsewhere shows up
   * quickly, long enough that a burst of reads costs one query.
   */
  private static readonly BLOCKLIST_MEMO_MS = 5_000;

  /**
   * Deadline for the blocklist query when it is ENRICHING a contact read, deliberately far below the
   * engine-wide budget `/contacts/blocked` uses. There the blocklist is the answer and waiting is
   * right; here it is one field on rows the caller already has, and a contact read used to be an
   * in-memory lookup. Past this the read returns with isBlocked at its default and a warning —
   * the same degradation a failed query already produces.
   */
  private static readonly BLOCKLIST_ENRICHMENT_BUDGET_MS = 5_000;

  /**
   * The account's blocked ids, or null when the query failed.
   *
   * Memoised because a single contact read is not the only caller: a session seeding its status
   * history resolves each unique poster through getContactById purely to read a NAME
   * (session-engine-leaf-events), so querying per read turned one connect into N network round-trips,
   * each with its own deadline. The failure is memoised too — a broken blocklist must not cost N
   * queries either — and block/unblock invalidate it so a just-changed state is not read stale.
   */
  private async blockedIds(): Promise<Set<string> | null> {
    if (this.blocklistMemo && Date.now() - this.blocklistMemo.at < BaileysContacts.BLOCKLIST_MEMO_MS) {
      return this.blocklistMemo.ids;
    }
    // Share one query with every caller that arrives while it is open, so a burst costs one round
    // trip rather than one per caller. Note which callers this actually helps: the status seed
    // resolves posters SEQUENTIALLY (`await resolvePoster(...)` per item) and memoises per jid, so it
    // never has two lookups in flight — the memo above is what bounds that loop. This bounds
    // genuinely concurrent readers instead, such as two contact requests arriving together.
    this.blocklistInFlight ??= this.queryBlockedIds();
    return this.blocklistInFlight;
  }

  private async queryBlockedIds(): Promise<Set<string> | null> {
    // Read before the query so an invalidation that lands DURING it can be detected: block/unblock
    // clears the memo, and a pre-change answer arriving afterwards would re-memoise the state the
    // caller just changed, for the whole window.
    const generation = this.blocklistGeneration;
    let ids: Set<string> | null;
    try {
      ids = new Set(await this.getBlockedContacts(BaileysContacts.BLOCKLIST_ENRICHMENT_BUDGET_MS));
    } catch (error) {
      this.host.logger.warn('Blocklist unavailable; contact isBlocked left at its default', {
        error: error instanceof Error ? error.message : String(error),
      });
      ids = null;
    } finally {
      // Only if the handle is still this query's. After an invalidation the field belongs to a query
      // started later, and clearing it there would send the next reader into a third query while the
      // second was still open — defeating the sharing exactly inside the window it introduced.
      if (generation === this.blocklistGeneration) {
        this.blocklistInFlight = undefined;
      }
    }
    // Stamped with the time the ANSWER arrived, not the time the query started. Stamping the start
    // wrote an already-expired memo for any query slower than the window — so the memo absorbed
    // only the fast queries and collapsed on exactly the slow ones it was added for.
    if (generation === this.blocklistGeneration) {
      this.blocklistMemo = { at: Date.now(), ids };
    }
    return ids;
  }

  /** Bumped by block/unblock so an in-flight query cannot memoise pre-change state afterwards. */
  private invalidateBlocklist(): void {
    this.blocklistMemo = undefined;
    this.blocklistInFlight = undefined;
    this.blocklistGeneration += 1;
  }

  /**
   * `resolvePhone` reads caches only, so for a lid its null means "not cached", not "no phone": the
   * mapping may have been evicted, or sit past the preload cap after a restart. Answering null there
   * told the sender resolver the lid had no phone, and it stored that null over the real mapping. So a
   * lid miss reads the persisted table, then Baileys' own signal-key mapping, and rejects when neither
   * knows it; a rejection is a transient unknown the resolver neither caches nor persists.
   */
  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    const cached = this.host.resolvePhone(contactId);
    if (cached || parseWaId(contactId).kind !== 'lid') return cached;
    const persisted = await this.host.findPersistedLidPhone(contactId);
    if (persisted) return persisted;
    const pn = await this.sock()
      .signalRepository?.lidMapping?.getPNForLID(contactId)
      .catch(() => null);
    if (pn) {
      this.host.recordLidMapping(contactId, pn, false);
      return userPart(pn);
    }
    throw new LidNotMappedError(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChats(): Promise<ChatSummary[]> {
    this.host.ensureReady();
    return this.host.listChats();
  }

  async sendSeen(
    chatId: string,
    messageIds?: string[],
    authors?: ReadonlyMap<string, string>,
    stored?: StoredChatMessageLookup,
  ): Promise<boolean> {
    this.host.ensureReady();
    const socket = this.sock();
    const keys = await this.receiptKeys(socket, chatId, messageIds, authors, stored);
    if (keys.length === 0) {
      return false; // nothing known to mark read
    }
    // readMessages reaches fetchPrivacySettings, which destructures the query result and throws a
    // raw TypeError on an unanswered one — no Boom, so nothing downstream can classify it. Marking
    // a chat read is idempotent, so bounding it is safe: a repeat costs nothing.
    await this.confirmed(this.sock(socket).readMessages(keys), 'the read receipt');
    return true;
  }

  /**
   * The keys a read receipt should acknowledge: the messages the caller named, or the newest one the
   * chat received when it named none.
   *
   * Baileys acknowledges individual messages, not chats, and the receipt node enumerates ids rather
   * than carrying a read-up-to watermark. Caller-supplied ids are what make that correct: the
   * lastInboundMessage fallback holds only the newest message, so a burst of three inbound messages
   * left the first two permanently unread, and a session that restarted since the message arrived
   * had nothing to acknowledge at all (a silent false under a 200).
   *
   * Named ids are resolved through the message store rather than synthesised, because the receipt
   * needs the whole key. A synthesised key carries no `participant`, so a group receipt names no
   * sender; its hardcoded `fromMe: false` is wrong for an id that belongs to an outbound message;
   * and its jid is whichever dialect the caller happened to send. The stored key has all three
   * right. Ids the store has never seen — history backfill is emitted but not persisted — keep the
   * synthesised key in a 1:1 chat, which is what that case ran on before. A group receipt that names
   * no sender cannot be attributed, so there the key takes `authors` (message id to the stored poster,
   * which the gateway keeps for every group message), and an id with no known author is left out of
   * the receipt rather than sent as one WhatsApp may ignore.
   */
  private async receiptKeys(
    socket: WASocket,
    chatId: string,
    messageIds?: string[],
    authors?: ReadonlyMap<string, string>,
    storedLast?: StoredChatMessageLookup,
  ): Promise<WAMessageKey[]> {
    // null as well as undefined: the REST body rejects an explicit null, but this is the engine
    // boundary and an internal caller reaching it with one used to dereference it below as a 500.
    if (messageIds === undefined || messageIds === null) {
      // The newest RECEIVED message, not the preview: after an API reply the preview is an own key,
      // which Baileys drops from the receipt, so the call would answer true having sent nothing.
      // After a restart memory holds none until the next one arrives; the gateway's stored copy
      // stands in, rebuilt the way a chat write keys it.
      const last = this.sinceDeletion(chatId, this.host.lastInboundMessage(chatId));
      if (last && (await this.matchesChat(last.key, chatId, socket))) return [last.key];
      if (!isEngineChatId(chatId)) return [];
      const row = this.sinceDeletion(chatId, await this.readStored(chatId, storedLast));
      const received = row && !row.fromMe ? this.storedTarget(chatId, row) : null;
      return received && (await this.matchesChat(received.key, chatId, socket)) ? [received.key] : [];
    }
    if (messageIds.length === 0) {
      return []; // an explicit empty list asks for nothing to be acknowledged, not for the newest
    }
    const remoteJid = this.host.toEngineJid(chatId);
    const stored = (await this.host.getStoredMessages(messageIds)) ?? [];
    // A stored key is only usable when it belongs to THIS chat. Without the check, an id from
    // another chat in the same session carried that chat's remoteJid into readMessages, so the
    // receipt landed there while the route answered success for the chat the caller named.
    // The comparison runs in the NEUTRAL dialect rather than the engine one: toEngineJid folds
    // @c.us and @s.whatsapp.net together but returns @lid untouched, and Baileys stores a DM key
    // under the peer's lid once WhatsApp addresses the chat that way. toNeutralJid resolves that
    // lid to its phone user-part through the session's lid mapping, so both spellings of one chat
    // still meet. Anything that still differs falls back to the synthesised key for the ADDRESSED
    // chat, which is exactly what every id ran on before stored keys existed.
    const keyById = new Map<string, WAMessageKey>();
    for (const msg of stored) {
      if (msg.key?.id && msg.key.remoteJid && (await this.matchesChat(msg.key, chatId, socket))) {
        keyById.set(msg.key.id, msg.key);
      }
    }
    const inGroup = chatKind(remoteJid) === 'group';
    return messageIds.flatMap((id): WAMessageKey[] => {
      const key = keyById.get(id);
      if (key) return [key];
      if (!inGroup) return [{ remoteJid, id, fromMe: false }];
      const author = authors?.get(id);
      return author ? [{ remoteJid, id, fromMe: false, participant: this.host.toEngineJid(author) }] : [];
    });
  }

  private async matchesChat(key: WAMessageKey, chatId: string, expected?: WASocket): Promise<boolean> {
    const socket = this.sock(expected);
    const persisted = await storedKeyInChatPersisted(key, chatId, jid => this.host.findPersistedLidPhone(jid));
    this.sock(socket);
    if (persisted) return true;
    const requested = parseWaId(chatId);
    const stored = parseWaId(key.remoteJid ?? '');
    if (!((requested.kind === 'user' && stored.kind === 'lid') || (requested.kind === 'lid' && stored.kind === 'user')))
      return false;
    const phone = requested.kind === 'user' ? requested.userPart : stored.userPart;
    const lid = requested.kind === 'lid' ? requested.userPart : stored.userPart;
    if (typeof socket.executeUSyncQuery !== 'function' || !this.host.loadLib) return false;
    const library = await this.host.loadLib();
    this.sock(socket);
    const confirmed = await queryLidPhone(socket, library, phone, lid, this.queryBudgetMs);
    this.sock(socket);
    if (confirmed) this.host.recordLidMapping(`${lid}@lid`, `${phone}@s.whatsapp.net`);
    return confirmed;
  }

  async confirmedChatJid(chatId: string): Promise<string> {
    const jid = this.host.chatJid(chatId);
    if (!(await this.matchesChat({ remoteJid: jid }, chatId))) throw new RecipientUnreachableError(chatId);
    return jid;
  }

  /**
   * The message a chat write is keyed to, and the jid that indexes the patch, made to agree (#1891).
   *
   * The phone applies a clear or delete only when both name the chat the way it holds it. A message
   * this session holds in memory carries that form itself: the patch is indexed by the jid the
   * message arrived under, its lid on a lid-addressed chat and its phone jid otherwise. Indexing it by
   * the listed phone jid instead named two different chats, which the server accepted and the phone
   * ignored. A stored message carries no addressing, so it is keyed by the chat's lid whenever one is
   * known (the stored row brings the one the engine reported for its phone), else by the phone jid.
   *
   * An own group message carries no `participant` (the phone ignores the range with one); a received
   * one needs its sender, which Baileys requires.
   *
   * The message is the newest one in memory, else (none, or one that yields no usable key) the newest
   * the gateway stored. Either key must belong to the chat ({@link matchesChat}), else it is not used.
   * With neither, `rangeless()` allows a patch without a range: it is indexed by the chat's jid, and
   * only for a chat the session knows (a message in memory or stored, or a chat record or state row
   * the listing holds) whose jid passes the same check. Otherwise the answer is null.
   *
   * Only the message in memory serves an id spelled any other way than the engine keys chats
   * ({@link isEngineChatId}): the stored lookup normalizes the id and finds the chat's rows, but the
   * patch would still be indexed by the misspelled id, which names no chat on the phone.
   *
   * A message, in memory or stored, sent at or before WhatsApp deleted the chat neither keys the write
   * nor shows the session knows the chat (see {@link sinceDeletion}).
   */
  private async chatWriteRange(
    socket: WASocket,
    chatId: string,
    stored: StoredChatMessageLookup | undefined,
    rangeless: () => boolean = () => false,
  ): Promise<ChatWriteRange | null> {
    const last = this.sinceDeletion(chatId, this.host.lastMessage(chatId));
    const inMemory = last ? this.memoryTarget(chatId, last.key, last.timestamp) : null;
    if (inMemory && (await this.matchesChat(inMemory.key, chatId, socket))) return toRange(inMemory);
    if (!isEngineChatId(chatId)) return null;
    const row = this.sinceDeletion(chatId, await this.readStored(chatId, stored));
    const fromStore = row ? this.storedTarget(chatId, row) : null;
    if (fromStore && (await this.matchesChat(fromStore.key, chatId, socket))) return toRange(fromStore);
    if (!rangeless() || !(last || row || this.listedChats(chatId).length)) return null;
    const jid = this.host.chatJid(chatId);
    return (await this.matchesChat({ remoteJid: jid }, chatId, socket)) ? { jid, lastMessages: [] } : null;
  }

  private async readStored(
    chatId: string,
    stored: StoredChatMessageLookup | undefined,
  ): Promise<StoredChatMessage | null> {
    if (!stored) return null;
    try {
      return await stored();
    } catch (err) {
      this.host.logger.warn('Could not read the stored last message of a chat', {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * The message, unless it was sent at or before WhatsApp deleted the chat. WhatsApp keeps nothing of a
   * deleted chat while the gateway keeps its stored messages: a write keyed to one names a message the
   * phone no longer holds, and Baileys applies its own patch locally all the same, so the deleted chat
   * would be listed again. Such a message does not show the chat exists either.
   */
  private sinceDeletion<T extends { timestamp: number }>(chatId: string, message: T | null): T | null {
    const deletedAt = this.host.chatDeletedAt(chatId);
    return message && (deletedAt === null || message.timestamp * 1000 > deletedAt) ? message : null;
  }

  /** A message held in memory, keyed under the jid it arrived with; null when it cannot be used. */
  private memoryTarget(chatId: string, key: WAMessageKey, timestamp: number): WriteTarget | null {
    if (!key.id || !timestamp) return null;
    const chatJid = this.host.chatJid(chatId);
    const group = parseWaId(chatJid).kind === 'group';
    const fromMe = key.fromMe === true;
    if (group && !fromMe && !key.participant) return null;
    const jid = group ? chatJid : this.host.toEngineJid(key.remoteJid ?? chatJid);
    return target(jid, key.id, fromMe, group && !fromMe ? (key.participant ?? undefined) : undefined, timestamp);
  }

  /** A stored message, keyed by the chat's lid whenever one is known; null when it cannot be used. */
  private storedTarget(chatId: string, row: StoredChatMessage): WriteTarget | null {
    if (!row.id || !row.timestamp) return null;
    const chatJid = this.host.chatJid(chatId);
    const group = parseWaId(chatJid).kind === 'group';
    if (group && !row.fromMe && !row.author) return null;
    const jid = group ? chatJid : (row.lid ?? this.host.lidOf(chatJid) ?? this.host.toEngineJid(chatJid));
    const participant =
      group && !row.fromMe && row.author
        ? (row.authorLid ?? this.host.lidOf(row.author) ?? this.host.toEngineJid(row.author))
        : undefined;
    return target(jid, row.id, row.fromMe, participant, row.timestamp);
  }

  /**
   * The chat as the session lists it (a chat record or a persisted state row) under any spelling of it: a
   * row is keyed by the lid or the phone it was learned under, whichever form the caller writes it with.
   */
  private listedChats(chatId: string): ChatSummary[] {
    const ids = new Set(this.host.chatTwins(chatId).map(jid => this.host.toNeutralJid(jid)));
    return this.host.listChats().filter(chat => ids.has(chat.id));
  }

  /**
   * Without a known message the mark goes out with no range, which the phone applies to a chat in the
   * list. It is reported as not done for an archived chat, which the phone leaves unmarked then, and
   * for a chat the session does not know or whose jid does not check out.
   */
  async markUnread(chatId: string, stored?: StoredChatMessageLookup): Promise<boolean> {
    this.host.ensureReady();
    const socket = this.sock();
    const range = await this.chatWriteRange(
      socket,
      chatId,
      stored,
      () => !this.listedChats(chatId).some(c => c.archived),
    );
    if (!range) return false;
    await this.confirmed(
      this.sock(socket).chatModify({ markRead: false, lastMessages: range.lastMessages }, range.jid),
      'the unread mark',
    );
    return true;
  }

  async clearChatMessages(chatId: string, stored?: StoredChatMessageLookup): Promise<boolean> {
    this.host.ensureReady();
    const socket = this.sock();
    const range = await this.chatWriteRange(socket, chatId, stored);
    if (!range) {
      return false; // the clear removes messages up to the one it is keyed to; never guess one
    }
    await this.confirmed(
      this.sock(socket).chatModify({ clear: true, lastMessages: range.lastMessages }, range.jid),
      'the chat clear',
    );
    return true;
  }

  /**
   * Without a known message the change goes out with no range, which WhatsApp applies as well, but
   * only for a chat the session knows and whose jid checks out. Baileys replays its own patch locally,
   * so archiving an id the account has no chat with would list that chat from then on.
   */
  async archiveChat(chatId: string, archive: boolean, stored?: StoredChatMessageLookup): Promise<boolean> {
    this.host.ensureReady();
    const socket = this.sock();
    const range = await this.chatWriteRange(socket, chatId, stored, () => true);
    if (!range) return false;
    await this.confirmed(
      this.sock(socket).chatModify({ archive, lastMessages: range.lastMessages }, range.jid),
      'the archive change',
    );
    return true;
  }

  async muteChat(chatId: string, muteUntil: number | null): Promise<void> {
    this.host.ensureReady();
    const socket = this.sock();
    // Deliberately no lastMessage lookup: the `mute` member of ChatModification carries no
    // `lastMessages`, unlike archive/clear/delete, so a chat with no known history mutes fine.
    const jid = await this.confirmedChatJid(chatId);
    await this.confirmed(this.sock(socket).chatModify({ mute: muteUntil }, jid), 'the mute change');
  }

  async pinChat(chatId: string, pin: boolean): Promise<boolean> {
    this.host.ensureReady();
    const socket = this.sock();
    // No lastMessage lookup: the `pin` member of ChatModification carries no `lastMessages`, unlike
    // archive/clear/delete, so a chat with no known history pins fine. Always true — Baileys writes
    // the app-state patch and reports nothing back, so it has no equivalent of the whatsapp-web.js
    // three-pin refusal to surface.
    const jid = await this.confirmedChatJid(chatId);
    await this.confirmed(this.sock(socket).chatModify({ pin }, jid), 'the pin change');
    return true;
  }

  async deleteChat(chatId: string, stored?: StoredChatMessageLookup): Promise<boolean> {
    this.host.ensureReady();
    const socket = this.sock();
    const range = await this.chatWriteRange(socket, chatId, stored);
    if (!range) {
      return false; // the delete removes messages up to the one it is keyed to; never guess one
    }
    await this.confirmed(
      this.sock(socket).chatModify({ delete: true, lastMessages: range.lastMessages }, range.jid),
      'the chat delete',
    );
    return true;
  }
}

type WriteTarget = { jid: string; key: WAMessageKey; timestamp: number };
type ChatWriteRange = { jid: string; lastMessages: { key: WAMessageKey; messageTimestamp: number }[] };

function target(
  jid: string,
  id: string,
  fromMe: boolean,
  participant: string | undefined,
  timestamp: number,
): WriteTarget {
  return { jid, key: { remoteJid: jid, fromMe, id, ...(participant ? { participant } : {}) }, timestamp };
}

function toRange(write: WriteTarget): ChatWriteRange {
  return { jid: write.jid, lastMessages: [{ key: write.key, messageTimestamp: write.timestamp }] };
}

/**
 * Whether a chat id is spelled the way the engine keys chats: `<id>@g.us`, `<lid>@lid` or a phone in
 * either user dialect, lowercase, with no device suffix or surrounding space. chatJid folds a phone's
 * two dialects and nothing else, so `120363@G.US` or a bare `628111` would index a patch by a jid that
 * names no chat.
 */
function isEngineChatId(chatId: string): boolean {
  const { kind, userPart: id } = parseWaId(chatId);
  const domains =
    kind === 'group' ? ['g.us'] : kind === 'lid' ? ['lid'] : kind === 'user' ? ['c.us', 's.whatsapp.net'] : [];
  return domains.some(domain => chatId === `${id}@${domain}`);
}
