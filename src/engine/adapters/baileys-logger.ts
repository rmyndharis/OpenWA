import { BaileysLogger } from '../types/baileys.types';

/** Fully silent logger so Baileys does not spam stdout; diagnostics flow via connection.update. */
export function createSilentLogger(): BaileysLogger {
  const noop = (): void => {};
  const logger: BaileysLogger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return logger;
}

/** Keys whose value is a credential wherever it appears in a record the library hands over. */
const SECRET_KEYS: ReadonlySet<string> = new Set(['password', 'secret', 'token', 'apikey', 'api_key', 'authorization']);

/**
 * Replace credential-valued keys before a library record is serialised.
 *
 * Baileys hands this logger whatever object the failure carried, and a `socks` connect error carries
 * the whole proxy config, password included, as its only enumerable property. At debug level that
 * went to stdout verbatim, which on a shipped deployment means the proxy password in the container
 * log. Bounded depth: these records nest a couple of levels at most, and a logger must not walk an
 * arbitrary graph on the wire path.
 */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redactSecrets(v, depth + 1),
    ]),
  );
}

const BAILEYS_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * Baileys logger, silent by default. Set `BAILEYS_LOG_LEVEL` (trace|debug|info|warn|error) to surface
 * Baileys' own diagnostics - the history/app-state sync decision flow ("awaiting notification", "App
 * state sync complete", MAC errors) at debug/info, and the raw decoded WA wire frames at trace. Emits
 * JSON lines to stdout (context "baileys-wire") independent of the app log level, so a run can be
 * captured with `BAILEYS_LOG_LEVEL=trace node dist/main > baileys-wire.log`.
 */
export function createBaileysLogger(): BaileysLogger {
  const configured = (process.env.BAILEYS_LOG_LEVEL ?? 'silent').toLowerCase();
  if (!BAILEYS_LOG_LEVELS.includes(configured)) {
    return createSilentLogger();
  }
  const threshold = BAILEYS_LOG_LEVELS.indexOf(configured);
  const write =
    (lvl: string) =>
    (obj: unknown, msg?: string): void => {
      if (BAILEYS_LOG_LEVELS.indexOf(lvl) < threshold) {
        return;
      }
      const rec = redactSecrets(
        typeof obj === 'string' ? { msg: obj } : { ...(obj as Record<string, unknown>), ...(msg ? { msg } : {}) },
      ) as Record<string, unknown>;
      process.stdout.write(
        JSON.stringify({ ts: new Date().toISOString(), level: lvl, context: 'baileys-wire', ...rec }) + '\n',
      );
    };
  const logger: BaileysLogger = {
    level: configured,
    child: () => logger,
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
  return logger;
}
