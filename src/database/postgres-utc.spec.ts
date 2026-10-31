import * as net from 'net';
import { ClientBase, defaults as pgDefaults, Pool, types as pgTypes } from 'pg';
import { DataSource } from 'typeorm';
import { assertDataConnectionUtc, parseTimestampAsUtc, postgresUtcExtra, utcTimestampTypes } from './postgres-utc';
import { buildPostgresDataSourceOptions } from './data-source';

// Keep the checkout's own .env and data/.env.generated out: the CLI data sources load them on import.
jest.mock('./load-cli-env', () => ({ loadCliEnv: jest.fn() }));

// pg serialises a bound parameter through this module-level helper; there is no per-client seam, so
// this is where the input half of the pin is observable without a server.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prepareValue } = require('pg/lib/utils') as { prepareValue: (value: unknown) => unknown };

/**
 * Just enough of the wire protocol to get a real pg pool past connect and up to its first statement,
 * which on a pinned pool is the `SET TIME ZONE`. Both failure modes the pin has to survive are server
 * behaviour, so they are served by a real socket rather than a stubbed client: the pool's own connect
 * path is the thing under test.
 */
const frame = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const AUTHENTICATION_OK = frame('R', Buffer.alloc(4)); // int32 0 = AuthenticationOk
const READY_FOR_QUERY = frame('Z', Buffer.from('I', 'ascii'));
const errorResponse = (message: string): Buffer => {
  const field = (code: string, value: string): Buffer =>
    Buffer.concat([Buffer.from(code, 'ascii'), Buffer.from(value, 'utf8'), Buffer.from([0])]);
  return frame(
    'E',
    Buffer.concat([
      field('S', 'ERROR'),
      field('V', 'ERROR'),
      field('C', '0A000'),
      field('M', message),
      Buffer.from([0]),
    ]),
  );
};
const SIMPLE_QUERY = 0x51; // 'Q'

interface FakeServer {
  port: number;
  queries: string[];
  openSockets: () => number;
  close: () => Promise<void>;
}

/** Accepts a connection, then cuts the socket, refuses the first statement it receives or never answers it. */
const startFakeServer = async (onFirstQuery: 'cut' | 'refuse' | 'silent'): Promise<FakeServer> => {
  const sockets = new Set<net.Socket>();
  const queries: string[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      if (chunk[0] !== SIMPLE_QUERY) {
        socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY])); // startup packet
        return;
      }
      queries.push(chunk.subarray(5, chunk.length - 1).toString('utf8'));
      if (onFirstQuery === 'silent') return;
      if (onFirstQuery === 'cut') socket.destroy();
      else socket.write(Buffer.concat([errorResponse('SET TIME ZONE is not supported'), READY_FOR_QUERY]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    queries,
    openSockets: () => sockets.size,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

/**
 * One acquire against a fake server, with the process's own uncaught-exception handlers stood aside. An
 * acquire still pending after twice the connect budget is reported as a rejection of its own, so a hang
 * fails the assertion instead of the suite.
 */
const acquireThrough = async (
  fake: FakeServer,
  connectionTimeoutMillis = 5000,
): Promise<{ rejection?: string; uncaught: Error[]; socketsOnRejection: number }> => {
  const uncaught: Error[] = [];
  const installed = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', error => uncaught.push(error));

  const pool = new Pool({
    host: '127.0.0.1',
    port: fake.port,
    user: 'openwa',
    database: 'openwa',
    connectionTimeoutMillis,
    ...postgresUtcExtra(connectionTimeoutMillis),
  });
  pool.on('error', () => undefined);
  let rejection: string | undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.connect().then(client => client.release()),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('acquire still pending')), connectionTimeoutMillis * 2);
      }),
    ]);
  } catch (error) {
    rejection = (error as Error).message;
  } finally {
    clearTimeout(deadline);
  }
  // An unhandled 'error' event lands a turn after the acquire settles.
  await new Promise(resolve => setTimeout(resolve, 100));
  const socketsOnRejection = fake.openSockets();

  process.removeAllListeners('uncaughtException');
  for (const listener of installed) process.on('uncaughtException', listener as never);
  // A client stuck in its connect hook is never released, so pool.end() would wait for it forever.
  await Promise.race([pool.end().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 500))]);
  return { rejection, uncaught, socketsOnRejection };
};

describe('postgres UTC pin', () => {
  const originalInputPin = pgDefaults.parseInputDatesAsUTC;

  afterEach(() => {
    pgDefaults.parseInputDatesAsUTC = originalInputPin;
  });

  describe('reading', () => {
    it('reads a naive timestamp as UTC, not as host-local time', () => {
      expect((parseTimestampAsUtc('2026-01-01 00:00:00') as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect((parseTimestampAsUtc('2026-01-01 00:00:00.123456') as Date).toISOString()).toBe(
        '2026-01-01T00:00:00.123Z',
      );
      // The stock parser is what the shift looked like: the same text read as the PROCESS's wall
      // clock, which off UTC is a different instant. Stated against the host's own zone rather than a
      // fixed offset, because a jest worker cannot choose its zone: jest hands the test a COPY of
      // process.env, so assigning TZ there never reaches the runtime's timezone cache. The genuinely
      // off-UTC case is postgres-utc.pg.spec.ts, whose CI step sets TZ on the process itself.
      const stock = pgTypes.getTypeParser(1114, 'text') as (value: string) => Date;
      expect(stock('2026-01-01 00:00:00').getTime()).toBe(new Date(2026, 0, 1, 0, 0, 0).getTime());
    });

    it('leaves text the zoned parser cannot read to the stock parser', () => {
      const stock = pgTypes.getTypeParser(1114, 'text') as (value: string) => unknown;
      for (const value of ['infinity', '-infinity', '0044-03-15 12:00:00 BC']) {
        expect(parseTimestampAsUtc(value)).toEqual(stock(value));
      }
    });

    it('answers only the scalar text OID and leaves the timestamp[] parser alone', () => {
      // `_timestamp`, which holds pg-types' ARRAY parser. Handing back the scalar parser here would
      // turn `{"2026-01-01 00:00:00"}` into a single unparseable value. Typed as a plain number
      // because pg's typings enumerate the OIDs they know and this is not one of them.
      const timestampArrayOid: number = 1115;

      expect(utcTimestampTypes.getTypeParser(1114, 'text')).toBe(parseTimestampAsUtc);
      expect(utcTimestampTypes.getTypeParser(1114)).toBe(parseTimestampAsUtc);
      expect(utcTimestampTypes.getTypeParser(timestampArrayOid, 'text')).toBe(
        pgTypes.getTypeParser(timestampArrayOid, 'text'),
      );
      expect(utcTimestampTypes.getTypeParser(1114, 'binary')).toBe(pgTypes.getTypeParser(1114, 'binary'));
      expect(utcTimestampTypes.getTypeParser(1184, 'text')).toBe(pgTypes.getTypeParser(1184, 'text'));
    });
  });

  describe('writing', () => {
    it('binds a Date as UTC once the pin is applied', () => {
      const at = new Date('2026-01-01T00:00:00.000Z');
      // Back to pg's own default first: importing the data source above already applied the pin, and
      // the point of this test is the difference between the two. Unpinned, pg writes the parameter as
      // the PROCESS's wall clock, so the naive text a `timestamp` column receives follows the host's
      // zone; the instant it denotes is the same either way.
      pgDefaults.parseInputDatesAsUTC = false;
      expect(Date.parse(prepareValue(at) as string)).toBe(at.getTime());

      postgresUtcExtra();

      expect(pgDefaults.parseInputDatesAsUTC).toBe(true);
      expect(prepareValue(at)).toBe('2026-01-01T00:00:00.000+00:00');
    });
  });

  describe('wiring', () => {
    it('pins every connection the migration CLI data source opens', () => {
      const extra = buildPostgresDataSourceOptions({ DATABASE_TYPE: 'postgres' }).extra as {
        types?: unknown;
        onConnect?: unknown;
      };
      expect(extra.types).toBe(utcTimestampTypes);
      expect(extra.onConnect).toBe(postgresUtcExtra().onConnect);
      expect(pgDefaults.parseInputDatesAsUTC).toBe(true);
    });

    it('fails the acquire, and not the process, when the socket dies during the pin', async () => {
      // A failover or a pooler recycling the backend mid-statement. The pin runs inside the pool's own
      // connect, so it must run with the pool's 'error' listener already attached: a client emitting
      // 'error' with no listener is an uncaught exception, which takes the gateway down instead of
      // rejecting one acquire.
      const fake = await startFakeServer('cut');
      const { rejection, uncaught } = await acquireThrough(fake);

      expect(fake.queries).toEqual(["SET TIME ZONE 'UTC'"]);
      expect(rejection).toBeTruthy();
      expect(uncaught).toEqual([]);
      await fake.close();
    });

    it('ends the connection when the server refuses the pin, instead of leaking a backend', async () => {
      // What a pooler in statement mode answers. The client is fully connected by then, so an acquire
      // that only reports the error leaves an authenticated backend open, once per acquire, until the
      // server runs out of connections.
      const fake = await startFakeServer('refuse');
      const { rejection, uncaught } = await acquireThrough(fake);

      expect(rejection).toContain('SET TIME ZONE is not supported');
      expect(uncaught).toEqual([]);
      expect(fake.openSockets()).toBe(0);
      await fake.close();
    });

    it('rejects the acquire, and closes the connection, when the server never answers the pin', async () => {
      // A database or pooler that accepts the connection and then goes quiet. pg-pool stops its connect
      // timer before it calls the hook, so without a bound of its own the acquire (and a boot waiting on
      // it) never ends.
      const fake = await startFakeServer('silent');
      const { rejection, uncaught, socketsOnRejection } = await acquireThrough(fake, 250);

      expect(fake.queries).toEqual(["SET TIME ZONE 'UTC'"]);
      expect(rejection).toMatch(/Query read timeout/);
      expect(socketsOnRejection).toBe(0);
      expect(uncaught).toEqual([]);
      await fake.close();
    });

    it.each([undefined, 0, -1, NaN, Infinity])('bounds the pin with the default budget for %s', async value => {
      const query = jest.fn().mockResolvedValue({});
      await postgresUtcExtra(value).onConnect({ query } as unknown as ClientBase);
      expect(query).toHaveBeenCalledWith({ text: "SET TIME ZONE 'UTC'", query_timeout: 10000 });
    });

    it('bounds the pin with the connection budget the data source was given', async () => {
      const query = jest.fn().mockResolvedValue({});
      const extra = buildPostgresDataSourceOptions({ DATABASE_CONNECTION_TIMEOUT_MS: '2500' }).extra as {
        onConnect: (client: ClientBase) => Promise<unknown>;
      };
      await extra.onConnect({ query } as unknown as ClientBase);
      expect(query).toHaveBeenCalledWith({ text: "SET TIME ZONE 'UTC'", query_timeout: 2500 });
    });

    // PgBouncer refuses statement_timeout in the startup packet, so the pool's session settings ride in
    // the pin's own statement, under its bound.
    it('sets the pool statement_timeout and search_path in the same statement as the zone', async () => {
      const query = jest.fn().mockResolvedValue({});
      await postgresUtcExtra(2500, { statementTimeoutMs: 30000, searchPath: 'openwa,public' }).onConnect({
        query,
      } as unknown as ClientBase);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith({
        text: "SET TIME ZONE 'UTC'; SET statement_timeout = 30000; SELECT set_config('search_path', 'openwa,public', false)",
        query_timeout: 2500,
      });
    });

    it.each([0, undefined, NaN])(
      'sets no statement_timeout for %s, as pg sent none in the startup packet',
      async value => {
        const query = jest.fn().mockResolvedValue({});
        const extra = postgresUtcExtra(undefined, { statementTimeoutMs: value });
        await extra.onConnect({ query } as unknown as ClientBase);
        expect(query).toHaveBeenCalledWith({ text: "SET TIME ZONE 'UTC'", query_timeout: 10000 });
        expect(extra.onConnect).toBe(postgresUtcExtra().onConnect);
      },
    );

    it('quotes a search_path value as a literal', async () => {
      const query = jest.fn().mockResolvedValue({});
      await postgresUtcExtra(undefined, { searchPath: "o'wa,public" }).onConnect({ query } as unknown as ClientBase);
      expect(query).toHaveBeenCalledWith({
        text: "SET TIME ZONE 'UTC'; SELECT set_config('search_path', 'o''wa,public', false)",
        query_timeout: 10000,
      });
    });
  });

  describe('boot assertion', () => {
    const dataSourceReporting = (zone: string, offsetSeconds: number, laterOffsetSeconds = offsetSeconds): DataSource =>
      ({
        query: () =>
          Promise.resolve([{ zone, offset_seconds: offsetSeconds, offset_seconds_later: laterOffsetSeconds }]),
      }) as unknown as DataSource;

    it('passes for any zone whose offset is zero year round', async () => {
      await expect(assertDataConnectionUtc(dataSourceReporting('UTC', 0))).resolves.toBeUndefined();
      await expect(assertDataConnectionUtc(dataSourceReporting('Etc/UTC', 0))).resolves.toBeUndefined();
      await expect(assertDataConnectionUtc(dataSourceReporting('GMT', 0))).resolves.toBeUndefined();
    });

    it('fails naming the zone when the session is not on UTC', async () => {
      await expect(assertDataConnectionUtc(dataSourceReporting('Asia/Jakarta', 25200))).rejects.toThrow(
        /TimeZone is "Asia\/Jakarta" \(offset 25200s now, 25200s in six months/,
      );
    });

    it('fails a daylight-saving zone that happens to read +00 right now', async () => {
      // Europe/London, Europe/Lisbon and Atlantic/Canary sit at +00 from late October to late March. A
      // boot in that window used to read offset 0 and report the pin as applied, and from the last
      // Sunday in March every DEFAULT now() would then be written an hour ahead of what the driver
      // reads back, with no restart in between to catch it.
      await expect(assertDataConnectionUtc(dataSourceReporting('Europe/London', 0, 3600))).rejects.toThrow(
        /TimeZone is "Europe\/London" \(offset 0s now, 3600s in six months/,
      );
      await expect(assertDataConnectionUtc(dataSourceReporting('Europe/Lisbon', 3600, 0))).rejects.toThrow(
        /TimeZone is "Europe\/Lisbon"/,
      );
    });
  });
});
