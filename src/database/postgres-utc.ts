import { ClientBase, defaults as pgDefaults, types as pgTypes } from 'pg';
import { DataSource } from 'typeorm';

/**
 * UTC pin for the PostgreSQL data connection.
 *
 * Every timestamp column on this connection is `timestamp without time zone`, which carries no zone at
 * all: a stored value means whatever the writer's convention was. Three writers touch those columns and
 * they did not agree.
 *
 *  - the driver binds a JS Date as the PROCESS's local wall time (`sessions.connectedAt`, the lease
 *    columns, the pending-delivery stamps: every column the app itself writes),
 *  - the driver parses a naive timestamp back as PROCESS-local,
 *  - `DEFAULT now()`, which is what fills a `@CreateDateColumn`/`@UpdateDateColumn` the app leaves
 *    alone (TypeORM binds one only when a value is passed, as the lid-mapping, chat-state and
 *    message-store upserts and the Baileys history backfill do), writes the SERVER session's zone.
 *
 * Off UTC the row therefore carries two conventions at once, and comparisons that mix them are wrong by
 * the offset: a retention `LessThan(cutoff)` binds the cutoff as local wall time and measures it against
 * `createdAt` written in the server's zone. The same split is what shifts a backup on restore, because
 * the archive's ISO text is bound as text and the server drops its zone.
 *
 * So the connection is pinned end to end: bind as UTC, parse as UTC, and hold the session on UTC.
 */

/** `timestamp without time zone`. */
const TIMESTAMP_OID = 1114;
/** `timestamp with time zone`, borrowed for its parser and never overridden. */
const TIMESTAMPTZ_OID = 1184;

const parseNaiveTimestamp = pgTypes.getTypeParser(TIMESTAMP_OID, 'text') as (value: string) => unknown;
const parseZonedTimestamp = pgTypes.getTypeParser(TIMESTAMPTZ_OID, 'text') as (value: string) => unknown;

/**
 * `YYYY-MM-DD HH:MM:SS[.ffffff]`, the only shape these columns hold. `infinity`, `-infinity` and a BC
 * date reach the stock parser instead of having a zone appended to text it would not parse.
 */
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Read a naive timestamp as UTC, by handing it to the driver's own zoned parser with an explicit `+00`
 * rather than re-implementing date parsing here.
 */
export function parseTimestampAsUtc(value: string): unknown {
  return NAIVE_TIMESTAMP.test(value) ? parseZonedTimestamp(`${value}+00`) : parseNaiveTimestamp(value);
}

/**
 * The per-client parser table (pg wraps it in a `TypeOverrides` whose lookups fall through to here), so
 * the override is scoped to the connections built from it instead of landing in
 * `pg.types.setTypeParser`'s process-wide registry.
 *
 * ONLY the scalar OID is answered. The array form `_timestamp` (1115) holds pg-types' array parser, and
 * answering it with a scalar parser would turn every `timestamp[]` read into garbage; the schema has no
 * such column anyway (asserted in postgres-utc.pg.spec.ts), so it keeps the default parser and its
 * elements keep the driver's local-time reading.
 */
export const utcTimestampTypes = {
  getTypeParser(oid: number, format?: string): unknown {
    if (oid === TIMESTAMP_OID && (format ?? 'text') === 'text') return parseTimestampAsUtc;
    return pgTypes.getTypeParser(oid, format as Parameters<typeof pgTypes.getTypeParser>[1]);
  },
};

const SET_SESSION_UTC = "SET TIME ZONE 'UTC'";

/**
 * Pin a pooled session to UTC, through pg-pool's own connect hook.
 *
 * A statement on the connection itself, rather than the startup `options` parameter: `options` is not
 * guaranteed to survive the path to the server (a pooler may drop it, and PgBouncer refuses the startup
 * packet outright unless it is listed in `ignore_startup_parameters`), and on this connection it is
 * already spoken for by the search_path of a non-public schema. pg-pool awaits this hook for every
 * client it opens, the first one during `DataSource.initialize()` included, so none can start unpinned.
 *
 * The hook rather than a `Client` subclass that pins inside its own `connect`, because the pool owns two
 * things a subclass cannot reach. It attaches the client's `error` listener BEFORE calling the hook, so
 * a socket that dies during the statement (a failover, a pooler recycling the backend) fails the acquire
 * instead of reaching Node as an unhandled `error` event, which ends the process. And it calls
 * `client.end()` when the hook rejects, so a server that refuses the statement does not leave an
 * authenticated backend open once per acquire until `max_connections` runs out.
 *
 * `connectionTimeoutMillis` does NOT cover this statement: pg-pool clears that timer once the socket
 * is connected, before it invokes the hook, so a server that accepts the connection and then never
 * answers holds the acquire until the statement's own failure. Nothing else in the pool bounds it.
 */
const pinSessionToUtc = (client: ClientBase): Promise<unknown> => client.query(SET_SESSION_UTC);

/**
 * The `extra` block that pins a postgres data connection to UTC, for both entry points (the runtime
 * module and the migration CLI data source).
 *
 * The input direction is a side effect rather than a returned value: pg serialises a bound Date through
 * a module-level `prepareValue`, which reads this flag from the package defaults and has no per-client
 * form. Setting it here keeps it next to the two halves it belongs with, and ahead of any connection
 * built from the returned block.
 */
export function postgresUtcExtra(): { types: typeof utcTimestampTypes; onConnect: typeof pinSessionToUtc } {
  pgDefaults.parseInputDatesAsUTC = true;
  return { types: utcTimestampTypes, onConnect: pinSessionToUtc };
}

/**
 * Fail boot when the data connection's session is not actually on UTC.
 *
 * The pin is only two thirds applied without this: the driver would keep reading every naive timestamp
 * as UTC while `DEFAULT now()` kept writing the server's zone, so `createdAt` would be off by that
 * offset in every retention window and every ordering, silently and permanently. The ways it can be
 * left half-applied are real (a pooler that drops session state, a server-side default re-applied after
 * the SET), so the effective setting is read back rather than assumed.
 *
 * The offset is what is checked, not the name: `UTC`, `Etc/UTC` and `GMT` are all correct, and a name
 * check would fail a deployment that is already right. It is sampled at TWO instants six months apart,
 * because a single reading of `now()` does not separate a fixed +00 zone from one that observes daylight
 * saving: `Europe/London`, `Europe/Lisbon` and `Atlantic/Canary` all sit at +00 from late October to late
 * March, so a winter boot would pass an unpinned session and every summer `now()` would then be written
 * an hour ahead of what the driver reads back, with no restart in between to notice. The pair is taken
 * relative to `now()` rather than at fixed calendar dates so it follows the zone's CURRENT rules.
 */
export async function assertDataConnectionUtc(dataSource: DataSource): Promise<void> {
  const effectiveZone: Array<{ zone: string; offset_seconds: number; offset_seconds_later: number }> =
    await dataSource.query(
      `SELECT current_setting('TimeZone') AS zone,
              EXTRACT(TIMEZONE FROM now())::int AS offset_seconds,
              EXTRACT(TIMEZONE FROM now() + interval '6 months')::int AS offset_seconds_later`,
    );
  const [effective] = effectiveZone;
  if (effective?.offset_seconds === 0 && effective.offset_seconds_later === 0) return;
  throw new Error(
    `PostgreSQL data connection is not on UTC: TimeZone is "${effective?.zone}" ` +
      `(offset ${effective?.offset_seconds}s now, ${effective?.offset_seconds_later}s in six months; a zone that ` +
      `observes daylight saving is not UTC even while it reads +00). OpenWA stores every timestamp column in UTC. ` +
      `Set the server default to UTC (ALTER DATABASE "<database>" SET TimeZone='UTC'), or let the connection's own ` +
      `"SET TIME ZONE 'UTC'" through the pooler.`,
  );
}
