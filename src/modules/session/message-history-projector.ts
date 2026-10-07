import { ConfigService } from '@nestjs/config';
import { Repository, In, Raw } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { buildMessageMetadata, REVOKED_ROW_PATCH } from './message-row.mapper';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { LoggerService } from '../../common/services/logger.service';
import { resolveMessageRetentionCutoff } from '../message/message-retention.service';

/**
 * Persist pre-connection history without live dispatch. Stored revocations also notify plugin indexes
 * and return cleared identities for the engine's previews. Re-syncs de-duplicate by `waMessageId`.
 */
export async function persistHistoryMessages(
  messageRepository: Repository<Message>,
  configService: ConfigService | undefined,
  id: string,
  messages: IncomingMessage[],
  logger: LoggerService,
  isLive: () => boolean,
  notifyRevoked?: (row: Message) => void,
): Promise<IncomingMessage[]> {
  const cleared: IncomingMessage[] = [];
  const storeEphemeralMessages = resolveFeatureFlags(configService).storeEphemeralMessages;
  // Rows are stamped with WhatsApp's own time below, so history older than the retention window
  // would be written only for the next prune to delete it again.
  const retentionCutoffMs = resolveMessageRetentionCutoff()?.getTime();
  const byId = new Map<string, IncomingMessage>();
  for (const m of messages) {
    // Need an id to de-dup; chatId/from/to are NOT NULL; status/story posts aren't chats.
    if (!m.id || m.isStatusBroadcast || !m.chatId || !m.from || !m.to) {
      continue;
    }
    // Mirror the live onMessage guard: skip disappearing messages when the operator opted out, so a
    // history backfill can't bypass STORE_EPHEMERAL_MESSAGES=false. No-op when the flag is at its
    // default (true); only a message with a positive timer is dropped, never a regular one.
    if (!storeEphemeralMessages && (m.ephemeralDuration ?? 0) > 0) {
      continue;
    }
    if (byId.get(m.id)?.type !== 'revoked' || m.type === 'revoked') byId.set(m.id, m);
  }
  if (byId.size === 0) {
    return cleared;
  }
  // Chunk the dedup query: a batch can be thousands, past SQLite's bound-variable limit for IN (...).
  const ids = [...byId.keys()];
  const CHUNK = 400;
  let inserted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunkIds = ids.slice(i, i + CHUNK);
    const existing = await messageRepository.find({
      where: { sessionId: id, waMessageId: In(chunkIds) },
      select: { waMessageId: true, type: true },
    });
    // A delete() can retire the engine while a large batch works through its chunks; its transaction
    // has then already cleared this session's messages, and a row inserted after it (no FK) would
    // never be reaped. Same re-check the live inbound path makes after its awaits.
    if (!isLive()) break;
    const seen = new Set(existing.map(r => r.waMessageId));
    const rows = chunkIds
      .filter(x => !seen.has(x) || byId.get(x)?.type === 'revoked')
      // Old content is read for revocation checks but never reinserted. Content-free tombstones
      // must still clear a retained row and its preview, then follow ordinary retention pruning.
      .filter(x => {
        const m = byId.get(x)!;
        return (
          m.type === 'revoked' ||
          retentionCutoffMs === undefined ||
          !m.timestamp ||
          m.timestamp * 1000 >= retentionCutoffMs
        );
      })
      .map(x => {
        const m = byId.get(x)!;
        const metadata = buildMessageMetadata(m, true);
        const row = messageRepository.create({
          sessionId: id,
          waMessageId: m.id,
          chatId: m.chatId,
          // Group poster for inbound rows only — the account's own backfilled group messages must
          // not carry author (the column's contract is "null on outgoing echoes").
          author: m.fromMe ? undefined : m.author,
          from: m.from,
          to: m.to,
          body: m.body,
          type: m.type,
          direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
          timestamp: m.timestamp,
          status: MessageStatus.SENT,
          metadata,
        });
        if (m.type === 'revoked') Object.assign(row, REVOKED_ROW_PATCH);
        // The chat panel orders by createdAt; stamp the real time so history sorts correctly.
        if (m.timestamp) {
          row.createdAt = new Date(m.timestamp * 1000);
        }
        return row;
      });
    if (rows.length) {
      // Insert-or-ignore: a live onMessage insert can land between the `seen` SELECT above and this
      // write, colliding on UNIQUE(sessionId, waMessageId). orIgnore skips the collision instead of
      // throwing and aborting the whole batch (history is best-effort, persist-never-dispatch).
      await messageRepository
        .createQueryBuilder()
        .insert()
        .values(rows as unknown as QueryDeepPartialEntity<Message>[])
        .orIgnore()
        .execute();
      inserted += rows.length;
    }
    // Insert the tombstone before clearing an existing row: concurrent content inserts then either
    // lose the unique-key race or are cleared here, and a later chunk cannot resurrect the payload.
    for (const messageId of chunkIds) {
      const m = byId.get(messageId)!;
      if (m.type !== 'revoked') continue;
      if (!isLive()) break;
      await messageRepository.update(
        {
          sessionId: id,
          waMessageId: messageId,
          chatId: m.chatId,
          direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
        },
        REVOKED_ROW_PATCH,
      );
    }
    // An absent target first carries the revoke time. A later original supplies its real time,
    // even when a concurrent tombstone made its insert lose after the initial dedup query.
    if (rows.length || existing.some(row => row.type === 'revoked')) {
      const revoked = await messageRepository.find({
        where: { sessionId: id, waMessageId: In(chunkIds), type: 'revoked' },
      });
      for (const row of revoked) {
        const m = byId.get(row.waMessageId)!;
        if (!isLive()) break;
        const direction = m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING;
        if (row.chatId !== m.chatId || row.direction !== direction || !Number.isFinite(m.timestamp)) continue;
        if (row.timestamp == null || row.timestamp > m.timestamp) {
          const result = await messageRepository.update(
            {
              sessionId: id,
              waMessageId: m.id,
              chatId: m.chatId,
              direction,
              type: 'revoked',
              timestamp: Raw(alias => `(${alias} IS NULL OR ${alias} > :historyTimestamp)`, {
                historyTimestamp: m.timestamp,
              }),
            },
            { timestamp: m.timestamp, createdAt: new Date(m.timestamp * 1000) },
          );
          if (result.affected) {
            row.timestamp = m.timestamp;
            row.createdAt = new Date(m.timestamp * 1000);
          }
        }
        if (!isLive()) break;
        cleared.push({
          id: m.id,
          chatId: m.chatId,
          from: m.from,
          to: m.to,
          fromMe: m.fromMe,
          isGroup: m.isGroup,
          kind: m.kind,
          author: m.author,
          type: 'revoked',
          body: '',
          timestamp: Math.min(row.timestamp ?? m.timestamp, m.timestamp),
        });
        if (m.type === 'revoked') notifyRevoked?.(row);
      }
    }
  }
  if (inserted) {
    logger.log(`Persisted ${inserted} history message(s)`, {
      sessionId: id,
      inserted,
      action: 'history_messages_persisted',
    });
  }
  return cleared;
}
