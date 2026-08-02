import type * as BaileysLib from '@whiskeysockets/baileys';
import type { Chat, Contact as BaileysContact, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { EngineEventCallbacks, IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { buildIncomingMessageFromBaileys, extractBaileysBody } from './baileys-message-mapper';
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
  /** The chat's cached disappearing-messages timer extraction (`msg.ephemeralDuration` primary). */
  extractEphemeralDuration(msg: WAMessage): number | undefined;
  /** The currently-registered onHistoryMessages callback, if any (assigned at initialize()). */
  getOnHistoryMessages(): EngineEventCallbacks['onHistoryMessages'];
}

/** Baileys timestamps are `number | Long`; normalize to unix seconds. */
export function toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number {
  if (ts == null) {
    return Math.floor(Date.now() / 1000);
  }
  return typeof ts === 'number' ? ts : ts.toNumber();
}

export class BaileysHistory {
  constructor(private readonly host: BaileysHistoryHost) {}

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
   */
  async hydrateNames(): Promise<void> {
    try {
      const groups = await this.sock().groupFetchAllParticipating();
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
      await this.sock().resyncAppState(b.ALL_WA_PATCH_NAMES, false);
      this.host.logger.debug('Re-synced app state for contact names', { action: 'baileys_resync_appstate' });
    } catch (err) {
      this.host.logger.warn('App-state resync for contact names failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
        // Populate the disappearing-messages timer using the same extraction the live path and the
        // session-store cache share (`msg.ephemeralDuration` primary, `contextInfo.expiration` fallback),
        // so the history sink can apply the STORE_EPHEMERAL_MESSAGES opt-out symmetrically with onMessage.
        ephemeralDuration: this.host.extractEphemeralDuration(msg),
      },
      jid => this.host.toNeutralJid(jid),
    );
  }
}
