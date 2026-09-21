import type * as BaileysLib from '@whiskeysockets/baileys';
import type { Chat, Contact as BaileysContact, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { EngineEventCallbacks, IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import {
  buildIncomingMessageFromBaileys,
  extractBaileysBody,
  extractBaileysButtonReply,
  extractBaileysButtons,
  extractBaileysCommerce,
  isBaileysCatalogShare,
} from './baileys-message-mapper';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';
import { type createLogger } from '../../common/services/logger.service';

/**
 * History-sync machinery extracted from BaileysAdapter: the bulk `messaging-history.set`
 * capture and the post-connect name hydration. The adapter's lifecycle calls these methods
 * directly and injects this narrow host surface via closures, so the delegate never touches
 * lifecycle state directly.
 */
export interface BaileysHistoryHost {
  /** Socket handle for the post-connect hydration calls (fired on connection 'open'). */
  getSocket(): WASocket;
  readonly logger: ReturnType<typeof createLogger>;
  toNeutralJid(jid: string): string;
  normalizedSelfJid(): string;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  loadLib(): Promise<typeof BaileysLib>;
  /** Seed the chat's last-message preview + sort time from a history/live message. */
  recordMessage(msg: WAMessage): void;
  upsertContacts(records: Partial<BaileysContact>[]): void;
  upsertChats(records: Partial<Chat>[]): void;
  /**
   * How many saved contacts the in-memory session store currently holds. Reported alongside the
   * address-book restore so a log line says what the pull was worth; it does not decide whether the
   * pull happens, because a partial address book counts as plenty (see restoreAddressbookSnapshot).
   */
  contactCount(): number;
  /** The chat's cached disappearing-messages timer extraction (`msg.ephemeralDuration` primary). */
  extractEphemeralDuration(msg: WAMessage): number | undefined;
  /** The currently-registered onHistoryMessages callback, if any (assigned at initialize()). */
  getOnHistoryMessages(): EngineEventCallbacks['onHistoryMessages'];
}

/**
 * Baileys timestamps are `number | Long`; normalize to unix seconds.
 *
 * A third shape reaches here that the proto type does not admit: a decimal STRING. The library
 * decodes a message off the wire with `messageTimestamp` as a Long, and a Long serializes to its
 * decimal string, so a message read back out of `baileys_messages` (a JSON round trip) carries a
 * string where the type says number. Not EVERY stored message does: one persisted straight from a
 * send return was built in process with a plain number and round-trips as one. Delete-for-me and
 * edit both read this field off a stored message, so without the string arm they threw
 * `ts.toNumber is not a function` for any message that had come off the wire.
 *
 * Never answers NaN or Infinity, from any arm: a timestamp is not worth failing an operation over,
 * but a non-finite one poisons every arithmetic consumer downstream and would reach the wire. An
 * unusable value falls back to now, like an absent one.
 */
export function toUnixSeconds(ts: number | string | { toNumber(): number } | null | undefined): number {
  const now = (): number => Math.floor(Date.now() / 1000);
  if (ts == null) {
    return now();
  }
  if (typeof ts === 'number') {
    return Number.isFinite(ts) ? ts : now();
  }
  if (typeof ts === 'string') {
    const parsed = Number(ts);
    return Number.isFinite(parsed) ? parsed : now();
  }
  const converted = ts.toNumber();
  return Number.isFinite(converted) ? converted : now();
}

export class BaileysHistory {
  constructor(private readonly host: BaileysHistoryHost) {}

  /**
   * Whether the address-book snapshot has been pulled for this engine instance.
   *
   * One pull per process is what the in-memory contact store needs: it is empty at construction and
   * dies with the process, so every later reconnect on the same instance would re-download the whole
   * contact collection for a store that already holds it.
   */
  private addressbookRestored = false;

  /** Post-connect socket handle (hydrateNames runs on connection 'open'). */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  /**
   * Persist the bulk history Baileys pushes on connect (`messaging-history.set`) - the only
   * pre-connection history source. Maps each message media-free and hands the batch to the dispatch-free
   * `onHistoryMessages` callback, harvesting `pushName` into contacts on the way (history `contacts`
   * carry no names) and seeding each chat's last-message preview.
   */
  async captureHistoryMessages(messages: WAMessage[]): Promise<void> {
    if (!messages.length) {
      return;
    }
    const b = await this.host.loadLib();
    const nameUpdates: { id: string; notify: string }[] = [];
    const mapped: IncomingMessage[] = [];
    for (const msg of messages) {
      if (msg.key?.fromMe !== true && msg.pushName) {
        const sender = msg.key?.participant ?? msg.key?.remoteJid;
        if (sender) {
          nameUpdates.push({ id: sender, notify: msg.pushName });
        }
      }
      // Seed the chat's last-message preview + sort time (newest wins); else history-only chats
      // would read "No messages yet".
      this.host.recordMessage(msg);
      const incoming = this.mapHistoryMessage(b, msg);
      if (incoming) {
        mapped.push(incoming);
      }
    }
    if (nameUpdates.length) {
      this.host.upsertContacts(nameUpdates);
    }
    if (mapped.length) {
      this.host.getOnHistoryMessages()?.(mapped);
    }
  }

  /**
   * Backfill chat/contact display names after connect. Baileys 6.7.x often skips the initial app-state
   * sync (the state machine goes Online before it runs) and the PUSH_NAME sync can fail to decrypt, so
   * names never arrive. Fetch group subjects (reliable) and best-effort re-trigger the app-state sync;
   * both are non-fatal, and DM push-names still arrive via `contacts.update` on live messages.
   *
   * On a reconnect (`accountSyncCounter > 0`) Baileys skips history sync and the address-book snapshot
   * entirely: WhatsApp assumes the linked device kept its local copy. This gateway's contact store is
   * in-memory, so a process restart leaves GET /contacts empty. Once per engine instance we therefore drop
   * the stored version of the contact collection (so the next resync asks for a snapshot, not an
   * incremental patch) and process its mutations as an initial sync, which is what emits
   * `contacts.upsert` for the saved address book. The other collections keep the incremental resync
   * below.
   *
   * Once per engine instance, not "only when no saved contact is held": during the initial sync the event
   * buffer folds an app-state `contacts.upsert` into a `messaging-history.set` record it is already
   * holding for that id (`absorbed contact upsert in contact set` in Baileys' event-buffer), and the
   * whole initial sync is buffered as one batch, so those saved names arrive only inside the history
   * event, where the handler strips `name` because a history name is a chat title. The address book
   * is then PARTIAL rather than empty, and a count-based gate reads partial as "nothing to do" and
   * never repairs it. The snapshot pull is the only source that cannot be absorbed, so it runs on its
   * own schedule instead of on a count.
   */
  async hydrateNames(): Promise<void> {
    try {
      // Same ambiguity getGroups is bounded against: an unanswered query and an account with no groups
      // both yield `{}`, and query() resolves rather than throwing, so neither the catch below nor an
      // empty result can tell them apart. Without a clock of our own this step finishes silently — no
      // warn, because nothing threw, and no debug, because there was nothing to hydrate.
      const groups = await withQueryDeadline(
        this.sock().groupFetchAllParticipating(),
        BAILEYS_QUERY_BUDGET_MS,
        'WhatsApp did not answer the group list query in time',
      );
      const named = Object.values(groups)
        .filter(g => g?.id && g.subject)
        .map(g => ({ id: g.id, name: g.subject }));
      if (named.length) {
        this.host.upsertChats(named);
        this.host.logger.debug('Hydrated group names', { action: 'baileys_hydrate_groups', count: named.length });
      }
    } catch (err) {
      this.host.logger.warn('Group name hydration failed', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const b = await this.host.loadLib();
      const collections = b.ALL_WA_PATCH_NAMES;
      if (!collections?.length) {
        return;
      }
      const alreadySynced = (this.sock().authState?.creds?.accountSyncCounter ?? 0) > 0;
      if (alreadySynced && !this.addressbookRestored) {
        // Set before the await so a second connect cannot start a concurrent pull, and cleared again
        // if it fails, so one bad attempt does not count as the one pull this instance gets.
        this.addressbookRestored = true;
        try {
          await this.restoreAddressbookSnapshot();
        } catch (err) {
          this.addressbookRestored = false;
          throw err;
        }
      }
      await this.sock().resyncAppState(collections, false);
      this.host.logger.debug('Re-synced app state for contact names', { action: 'baileys_resync_appstate' });
    } catch (err) {
      this.host.logger.warn('App-state resync for contact names failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The app-state collection that carries `contactAction` mutations, i.e. the saved address book
   * (Baileys files its own contact edits under this name too). The other four collections carry chat
   * and message actions; a snapshot of those would re-emit every archive, pin, mute and star on each
   * restart for nothing, since only contacts are missing from the store.
   */
  private static readonly ADDRESSBOOK_COLLECTION = 'critical_unblock_low' as const;

  /**
   * Drop the persisted version of the contact collection and resync it from a snapshot so
   * `contactAction` mutations fire again. `null` in `keys.set` is Baileys' own delete; the next resync
   * then sets `return_snapshot` because the collection has no version. `isInitialSync: true` keeps
   * delete-chat mutations from wiping conversations that history is not about to rebuild.
   */
  private async restoreAddressbookSnapshot(): Promise<void> {
    const name = BaileysHistory.ADDRESSBOOK_COLLECTION;
    await this.sock().authState.keys.set({ 'app-state-sync-version': { [name]: null } });
    await this.sock().resyncAppState([name], true);
    this.host.logger.debug('Restored address-book snapshot after reconnect', {
      action: 'baileys_restore_addressbook',
      contacts: this.host.contactCount(),
    });
  }

  /**
   * Media-free WAMessage -> IncomingMessage map for bulk history (downloading media for thousands of
   * messages would be ruinous; the type is kept, the payload dropped). Returns null for protocol /
   * reaction / key / empty messages, which carry nothing for the chat view.
   */
  private mapHistoryMessage(b: typeof BaileysLib, msg: WAMessage): IncomingMessage | null {
    const raw = msg.message;
    if (!raw || !msg.key?.remoteJid || !msg.key.id) {
      return null;
    }
    // Unwrap ephemeral/viewOnce/documentWithCaption/edited wrappers so the real type and body surface —
    // else a disappearing-chat message maps to type 'unknown' with an empty body. Identity no-op when
    // already unwrapped. Derive ONE contentType from the normalized content for both the skip-filter and
    // the type mapping, and reuse extractBaileysBody (the same body extraction the live path uses).
    const content = b.normalizeMessageContent(raw) ?? raw;
    const contentType = b.getContentType(content);
    if (
      !contentType ||
      contentType === 'protocolMessage' ||
      contentType === 'reactionMessage' ||
      contentType === 'senderKeyDistributionMessage'
    ) {
      return null;
    }
    const body = extractBaileysBody(content);
    const commerce = extractBaileysCommerce(content, contentType);
    const button = extractBaileysButtonReply(content, contentType);
    const buttons = extractBaileysButtons(content, contentType);
    return buildIncomingMessageFromBaileys(
      {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        fromMe: msg.key.fromMe === true,
        participant: msg.key.participant ?? undefined,
        body,
        contentType,
        isPtt: content.audioMessage?.ptt === true,
        timestamp: toUnixSeconds(msg.messageTimestamp),
        pushName: msg.pushName ?? undefined,
        selfJid: this.host.normalizedSelfJid(),
        // Same commerce mapping as the live path, so a whole-catalog share is `unknown` on both.
        order: commerce.order,
        product: commerce.product,
        button,
        buttons,
        isCatalogShare: isBaileysCatalogShare(content),
        // Populate the disappearing-messages timer using the same extraction the live path and the
        // session-store cache share (`msg.ephemeralDuration` primary, `contextInfo.expiration` fallback),
        // so the history sink can apply the STORE_EPHEMERAL_MESSAGES opt-out symmetrically with onMessage.
        ephemeralDuration: this.host.extractEphemeralDuration(msg),
      },
      jid => this.host.toNeutralJid(jid),
    );
  }
}
