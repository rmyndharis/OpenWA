import { ConfigService } from '@nestjs/config';
import { Repository, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { buildMessageMetadata } from './message-row.mapper';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { LoggerService } from '../../common/services/logger.service';

/**
 * Persist pre-connection history into the `messages` table for the chat view, without webhook/hook/ws
 * dispatch (it predates the live session). De-duplicated by `waMessageId` so re-syncs never duplicate.
 */
export async function persistHistoryMessages(
  messageRepository: Repository<Message>,
  configService: ConfigService | undefined,
  id: string,
  messages: IncomingMessage[],
  logger: LoggerService,
): Promise<void> {
  const storeEphemeralMessages = resolveFeatureFlags(configService).storeEphemeralMessages;
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
    byId.set(m.id, m);
  }
  if (byId.size === 0) {
    return;
  }
  // Chunk the dedup query: a batch can be thousands, past SQLite's bound-variable limit for IN (...).
  const ids = [...byId.keys()];
  const CHUNK = 400;
  let inserted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunkIds = ids.slice(i, i + CHUNK);
    const existing = await messageRepository.find({
      where: { sessionId: id, waMessageId: In(chunkIds) },
      select: { waMessageId: true },
    });
    const seen = new Set(existing.map(r => r.waMessageId));
    const rows = chunkIds
      .filter(x => !seen.has(x))
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
  }
  if (inserted) {
    logger.log(`Persisted ${inserted} history message(s)`, {
      sessionId: id,
      inserted,
      action: 'history_messages_persisted',
    });
  }
}
