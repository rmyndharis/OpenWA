import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { MessageDirection } from '../../message/entities/message.entity';
import type { SearchProvider, SearchQuery, SearchResults, SearchHit } from '../search.types';

const LIMIT_CAP = Number(process.env.SEARCH_LIMIT_MAX) || 100;
const MAX_SNIPPET_WORDS = 24;

/** Shape returned by the dialect-specific SELECT in buildSqlite / buildPostgres. */
interface FtsResultRow {
  id: string;
  wa_message_id: string | null;
  session_id: string;
  chat_id: string;
  from: string;
  body: string | null;
  timestamp: string | number | null;
  type: string;
  direction: string;
  snippet: string | null;
  score: number | string | null;
}

interface CountRow {
  n: number | string;
}

/**
 * Built-in, DB-native full-text provider. Index sync is DB-level (generated tsvector / FTS5 triggers),
 * so this class ONLY queries — it never writes the index. See migration 1782400000000-AddMessagesFts.
 */
@Injectable()
export class BuiltInFtsProvider implements SearchProvider {
  readonly id = 'builtin-fts';
  readonly label = 'Built-in database full-text search';

  constructor(private readonly dataSource: DataSource) {}

  async search(query: SearchQuery): Promise<SearchResults> {
    const start = Date.now();
    const isPostgres = this.dataSource.options.type === 'postgres';
    const limit = Math.max(1, Math.min(query.limit ?? 50, LIMIT_CAP));
    const offset = Math.max(0, query.offset ?? 0);

    const { sql, params } = isPostgres
      ? this.buildPostgres(query, limit, offset)
      : this.buildSqlite(query, limit, offset);

    const rows = await this.dataSource.query<FtsResultRow[]>(sql, params);
    const hits: SearchHit[] = rows.map(r => this.mapRow(r));
    const total = rows.length < limit && offset === 0 ? rows.length : await this.count(query, isPostgres);

    return { hits, total, tookMs: Date.now() - start, provider: this.id };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private mapRow(r: FtsResultRow): SearchHit {
    return {
      messageId: r.id,
      waMessageId: r.wa_message_id ?? '',
      sessionId: r.session_id,
      chatId: r.chat_id,
      body: r.body ?? '',
      snippet: r.snippet ?? '',
      timestamp: Number(r.timestamp ?? 0),
      type: r.type as MessageType,
      direction: r.direction as MessageDirection,
      from: r.from,
      score: r.score == null ? undefined : Number(r.score),
    };
  }

  // --- SQLite FTS5 -----------------------------------------------------------
  private buildSqlite(q: SearchQuery, limit: number, offset: number) {
    const where: string[] = [`messages_fts MATCH ?`];
    const params: unknown[] = [q.q];
    this.applyFilters(where, params, q, 'm.');
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from" AS "from", m."body", m."timestamp", m."type", m."direction", snippet(messages_fts, 0, '<mark>', '</mark>', '…', ${MAX_SNIPPET_WORDS}) AS snippet, rank AS score`;
    const sql = `SELECT ${cols} FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')} ORDER BY rank, m."timestamp" DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return { sql, params };
  }

  // --- Postgres tsvector -----------------------------------------------------
  private buildPostgres(q: SearchQuery, limit: number, offset: number) {
    const where: string[] = [`m.body_ts @@ q.query`];
    const params: unknown[] = [];
    this.applyFilters(where, params, q, 'm.');
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from", m."body", m."timestamp", m."type", m."direction", ts_headline('simple', m."body", q.query, 'MaxFragments=1, MaxWords=${MAX_SNIPPET_WORDS}') AS snippet, ts_rank(m.body_ts, q.query) AS score`;
    const sql = `SELECT ${cols} FROM messages m, websearch_to_tsquery('simple', $${params.length + 1}) AS q(query) WHERE ${where.join(' AND ')} ORDER BY score DESC, m."timestamp" DESC LIMIT $${params.length + 2} OFFSET $${params.length + 3}`;
    params.push(q.q, limit, offset);
    return { sql, params };
  }

  private applyFilters(where: string[], params: unknown[], q: SearchQuery, prefix: string): void {
    if (q.sessionIds && q.sessionIds.length) {
      const ph = `(${q.sessionIds.map(() => '?').join(',')})`;
      where.push(`${prefix}"sessionId" IN ${ph}`);
      params.push(...q.sessionIds);
    }
    if (q.sessionId) {
      where.push(`${prefix}"sessionId" = ?`);
      params.push(q.sessionId);
    }
    if (q.chatId) {
      where.push(`${prefix}"chatId" = ?`);
      params.push(q.chatId);
    }
    if (q.from) {
      where.push(`${prefix}"from" = ?`);
      params.push(q.from);
    }
    if (q.direction) {
      where.push(`${prefix}"direction" = ?`);
      params.push(q.direction);
    }
    if (q.type) {
      const types = Array.isArray(q.type) ? q.type : [q.type];
      const ph = `(${types.map(() => '?').join(',')})`;
      where.push(`${prefix}"type" IN ${ph}`);
      params.push(...types);
    }
    if (q.dateFrom) {
      where.push(`${prefix}"timestamp" >= ?`);
      params.push(q.dateFrom);
    }
    if (q.dateTo) {
      where.push(`${prefix}"timestamp" <= ?`);
      params.push(q.dateTo);
    }
  }

  private async count(q: SearchQuery, isPostgres: boolean): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (isPostgres) {
      where.push(`m.body_ts @@ q.query`);
      this.applyFilters(where, params, q, 'm.');
      const sql = `SELECT count(*)::int AS n FROM messages m, websearch_to_tsquery('simple', $1) AS q(query)`;
      const rows = await this.dataSource.query<CountRow[]>(`${sql} WHERE ${where.join(' AND ')}`, [q.q, ...params]);
      return Number(rows[0]?.n ?? 0);
    }
    where.push(`messages_fts MATCH ?`);
    params.push(q.q);
    this.applyFilters(where, params, q, 'm.');
    const sql = `SELECT count(*) AS n FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid"`;
    const rows = await this.dataSource.query<CountRow[]>(`${sql} WHERE ${where.join(' AND ')}`, params);
    return Number(rows[0]?.n ?? 0);
  }
}
