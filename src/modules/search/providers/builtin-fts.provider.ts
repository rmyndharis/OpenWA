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

/** Returns the next placeholder token (`?` for SQLite, `$n` for Postgres). */
type PlaceholderFn = () => string;

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

  /**
   * Dialect-aware placeholder generator. SQLite binds `?` positionally by param-array order
   * (so we emit `?` regardless of slot). Postgres binds `$n` positional by the order tokens
   * APPEAR in the final SQL string — so each call returns the next `$n`, and callers MUST
   * invoke it in SQL-appearance order while pushing the matching param in the same step.
   */
  private static sqlitePlaceholder: PlaceholderFn = () => '?';
  private pgPlaceholder(): PlaceholderFn {
    let n = 0;
    return () => `$${++n}`;
  }

  // --- SQLite FTS5 -----------------------------------------------------------
  // SQL appearance order: MATCH term -> filters -> LIMIT -> OFFSET. Params pushed in that order.
  private buildSqlite(q: SearchQuery, limit: number, offset: number) {
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    const params: unknown[] = [];
    const where: string[] = [`messages_fts MATCH ${ph()}`];
    params.push(q.q);
    this.applyFilters(where, params, q, 'm.', ph);
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from" AS "from", m."body", m."timestamp", m."type", m."direction", snippet(messages_fts, 0, '<mark>', '</mark>', '…', ${MAX_SNIPPET_WORDS}) AS snippet, rank AS score`;
    const sql = `SELECT ${cols} FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')} ORDER BY rank, m."timestamp" DESC LIMIT ${ph()} OFFSET ${ph()}`;
    params.push(limit, offset);
    return { sql, params };
  }

  // --- Postgres tsvector -----------------------------------------------------
  // SQL appearance order: FTS term (in FROM clause) -> filters (in WHERE) -> LIMIT -> OFFSET.
  // The FTS term lives in `FROM messages m, websearch_to_tsquery('simple', $1) AS q(query)`,
  // which renders BEFORE the WHERE filters — so it must be `$1`, filters `$2..`, LIMIT/OFFSET last.
  // Params are pushed in the same order so the Nth param maps to `$N`.
  private buildPostgres(q: SearchQuery, limit: number, offset: number) {
    const ph = this.pgPlaceholder();
    const params: unknown[] = [];
    const ftsTerm = `websearch_to_tsquery('simple', ${ph()}) AS q(query)`;
    params.push(q.q);
    const where: string[] = [`m.body_ts @@ q.query`];
    this.applyFilters(where, params, q, 'm.', ph);
    // StartSel/StopSel are pinned to <mark>/</mark> to match the SQLite FTS5 snippet() output, so the
    // SearchHit.snippet contract stays dialect-agnostic (PG's ts_headline defaults to <b>/</b>).
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from", m."body", m."timestamp", m."type", m."direction", ts_headline('simple', m."body", q.query, 'MaxFragments=1, MaxWords=${MAX_SNIPPET_WORDS}, StartSel=<mark>, StopSel=</mark>') AS snippet, ts_rank(m.body_ts, q.query) AS score`;
    const sql = `SELECT ${cols} FROM messages m, ${ftsTerm} WHERE ${where.join(' AND ')} ORDER BY score DESC, m."timestamp" DESC LIMIT ${ph()} OFFSET ${ph()}`;
    params.push(limit, offset);
    return { sql, params };
  }

  /** Emits dialect-correct placeholders. For PG, MUST be called in SQL-appearance order. */
  private applyFilters(where: string[], params: unknown[], q: SearchQuery, prefix: string, ph: PlaceholderFn): void {
    if (q.sessionIds && q.sessionIds.length) {
      const placeholders = q.sessionIds.map(() => ph()).join(',');
      where.push(`${prefix}"sessionId" IN (${placeholders})`);
      params.push(...q.sessionIds);
    }
    if (q.sessionId) {
      where.push(`${prefix}"sessionId" = ${ph()}`);
      params.push(q.sessionId);
    }
    if (q.chatId) {
      where.push(`${prefix}"chatId" = ${ph()}`);
      params.push(q.chatId);
    }
    if (q.from) {
      where.push(`${prefix}"from" = ${ph()}`);
      params.push(q.from);
    }
    if (q.direction) {
      where.push(`${prefix}"direction" = ${ph()}`);
      params.push(q.direction);
    }
    if (q.type) {
      const types = Array.isArray(q.type) ? q.type : [q.type];
      const placeholders = types.map(() => ph()).join(',');
      where.push(`${prefix}"type" IN (${placeholders})`);
      params.push(...types);
    }
    if (q.dateFrom) {
      where.push(`${prefix}"timestamp" >= ${ph()}`);
      params.push(q.dateFrom);
    }
    if (q.dateTo) {
      where.push(`${prefix}"timestamp" <= ${ph()}`);
      params.push(q.dateTo);
    }
  }

  private async count(q: SearchQuery, isPostgres: boolean): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (isPostgres) {
      const ph = this.pgPlaceholder();
      const ftsTerm = `websearch_to_tsquery('simple', ${ph()}) AS q(query)`;
      params.push(q.q);
      where.push(`m.body_ts @@ q.query`);
      this.applyFilters(where, params, q, 'm.', ph);
      const sql = `SELECT count(*)::int AS n FROM messages m, ${ftsTerm} WHERE ${where.join(' AND ')}`;
      const rows = await this.dataSource.query<CountRow[]>(sql, params);
      return Number(rows[0]?.n ?? 0);
    }
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    where.push(`messages_fts MATCH ${ph()}`);
    params.push(q.q);
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT count(*) AS n FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')}`;
    const rows = await this.dataSource.query<CountRow[]>(sql, params);
    return Number(rows[0]?.n ?? 0);
  }
}
