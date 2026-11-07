import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, MessageDirection } from '../../modules/message/entities/message.entity';
import type { MessageType } from '../interfaces/whatsapp-engine.interface';

/** The newest message the gateway stored for one chat, as the Baileys listing seeds it after a restart. */
export interface StoredChatPreview {
  /** The chat id as stored: `<phone>@c.us`, `<lid>@lid`, `<id>@g.us` and so on. */
  chatId: string;
  /** The WhatsApp message id. */
  id: string;
  fromMe: boolean;
  /** Who posted a received group message, as stored. */
  author?: string;
  /** Epoch seconds. */
  timestamp: number;
  body?: string;
  type?: MessageType;
  /**
   * The name the newest message received in the chat came with: in a 1:1 chat the contact's own
   * (pushname), in a group the member who posted it. Absent when no received message carries one.
   */
  name?: string;
}

/**
 * Every spelling a stored row can name an account's own side by (`to` of a received message, `from` of a
 * sent one): its JID in either dialect, and the bare digits of an API send stored before 0.27.0. The `me`
 * placeholder of a send stored before the number was known names no account and is not among them. Every
 * reader that keeps only the rows of the account a session is linked to takes its spellings from here.
 */
export function ownAccountIds(phone: string): string[] {
  return [`${phone}@c.us`, `${phone}@s.whatsapp.net`, phone];
}

/**
 * Read port over the neutral `messages` table for a Baileys engine that starts with no chats: WhatsApp
 * resyncs no chat list to a device it already linked, so after a restart the stored rows are the only
 * record of a 1:1 chat with no persisted state. Kept to this one read so the engine never writes there.
 */
export interface StoredChatPreviewSource {
  /**
   * The newest stored message of each of the session's chats, newest chat first, from the `limit` chats
   * with the newest rows (0: all). Only rows of the account in `ownIds` (see {@link ownAccountIds}) count:
   * the table outlives an unlink, so a session linked to another number still holds the rows of the one
   * before. A row counts when the account's side of it (`to` of a received message, `from` of a sent one)
   * is one of those spellings. The limit is applied before that check, to keep the scan on the index: a
   * chat that holds only another account's rows, or rows without a WhatsApp id, uses a slot and lists
   * nothing.
   */
  latestPerChat(sessionId: string, ownIds: string[], limit: number): Promise<StoredChatPreview[]>;
}

@Injectable()
export class StoredChatPreviewService implements StoredChatPreviewSource {
  constructor(
    @InjectRepository(Message, 'data')
    private readonly repo: Repository<Message>,
  ) {}

  /**
   * Two steps, so the scan stays on `IDX_messages_session_chat_timestamp_id`. The candidate chats come
   * from that index alone (session, chat and time), newest first; the winner of each chat is then looked
   * up newest first in the same index, where the columns the index lacks are read for a few rows only.
   * Filtering on `waMessageId` in the first step instead reads every row of the session (about 500 ms
   * for 500k rows on SQLite against about 45 ms, and better-sqlite3 blocks the event loop meanwhile).
   *
   * A pending or failed send can have no WhatsApp id: it shows no chat and previews nothing, as live
   * (the #1891 rule). Rows of one second take the one stored last, as the stored lookup of a chat write
   * does; SQLite keeps `createdAt` to the second, so it breaks the tie by insertion order instead of by
   * the random id. The name comes from the newest received row of the chat, which need not be the newest
   * row: a support chat usually ends with a reply.
   */
  async latestPerChat(sessionId: string, ownIds: string[], limit: number): Promise<StoredChatPreview[]> {
    if (!ownIds.length) return [];
    const driver = this.repo.manager.connection.driver;
    const isPostgres = this.repo.manager.connection.options.type === 'postgres';
    const lastStored = isPostgres ? 'w."id"' : 'w."rowid"';
    // SQLite has no composite index on (sessionId, chatId, direction, timestamp), so between the two
    // indexes that each match two of this subquery's three equalities, it picks
    // IDX_messages_session_direction_timestamp_id (sessionId, direction) over
    // IDX_messages_session_chat_timestamp_id (sessionId, chatId) and then filters chatId per row,
    // scanning every row of the session with this direction once per candidate chat. A unary plus
    // makes the comparison an expression a bare-column index cannot serve, which steers SQLite onto
    // the chatId index instead, the one `w` below already uses. PostgreSQL has no such index choice
    // to steer and no unary `+` on a varchar column, so the hint is SQLite only.
    const nDirection = isPostgres ? 'n."direction"' : '+n."direction"';
    const table = this.repo.metadata.tablePath
      .split('.')
      .map(part => driver.escape(part))
      .join('.');
    const [sql, params] = driver.escapeQueryWithParameters(
      `SELECT m."chatId", m."waMessageId", m."direction", m."author", m."timestamp", m."body", m."type",
         (
           SELECT n."chatName" FROM ${table} n
           WHERE n."sessionId" = :sessionId AND n."chatId" = c."chatId" AND ${nDirection} = :incoming
             AND n."to" IN (:...ownIds) AND n."chatName" IS NOT NULL AND n."timestamp" IS NOT NULL
           ORDER BY n."timestamp" DESC
           LIMIT 1
         ) AS "name"
       FROM (
         SELECT l."chatId" FROM ${table} l
         WHERE l."sessionId" = :sessionId AND l."timestamp" IS NOT NULL
         GROUP BY l."chatId" ORDER BY MAX(l."timestamp") DESC${limit > 0 ? ` LIMIT ${Math.floor(limit)}` : ''}
       ) c
       JOIN ${table} m ON m."id" = (
         SELECT w."id" FROM ${table} w
         WHERE w."sessionId" = :sessionId AND w."chatId" = c."chatId"
           AND w."timestamp" IS NOT NULL AND w."waMessageId" IS NOT NULL
           AND (CASE WHEN w."direction" = :incoming THEN w."to" ELSE w."from" END) IN (:...ownIds)
         ORDER BY w."timestamp" DESC, w."createdAt" DESC, ${lastStored} DESC
         LIMIT 1
       )
       ORDER BY m."timestamp" DESC`,
      { sessionId, ownIds, incoming: MessageDirection.INCOMING },
    );
    const rows: Array<
      Pick<Message, 'chatId' | 'waMessageId' | 'direction' | 'author' | 'body' | 'type'> & {
        timestamp: number | string;
        name: string | null;
      }
    > = await this.repo.manager.query(sql, params);
    return rows.map(row => ({
      chatId: row.chatId,
      id: row.waMessageId,
      fromMe: row.direction === MessageDirection.OUTGOING,
      ...(row.author ? { author: row.author } : {}),
      // A bigint reads back as a string on PostgreSQL.
      timestamp: Number(row.timestamp),
      ...(row.body ? { body: row.body } : {}),
      type: row.type as MessageType,
      ...(row.name ? { name: row.name } : {}),
    }));
  }
}
