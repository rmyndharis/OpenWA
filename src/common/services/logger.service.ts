import { Injectable, LoggerService as NestLoggerService, Scope } from '@nestjs/common';
import { getRequestId } from './request-context';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
}

export enum LogFormat {
  JSON = 'json',
  PRETTY = 'pretty',
}

export interface LogContext {
  sessionId?: string;
  messageId?: string;
  webhookId?: string;
  action?: string;
  duration?: number;
  [key: string]: unknown;
}

// Defense-in-depth: redact the VALUES of secret-named keys before they reach the log sink, so a
// careless `logger.info('…', { password })` can't leak a credential. Matches the key NAME only
// (case-insensitive), never the value's content, to avoid false positives on innocuous fields.
const SECRET_KEY_PATTERN = /password|passwd|secret|token|api[-_]?key|authorization|credential|pepper|private[-_]?key/i;

/** Return a copy of `value` with secret-named keys' values replaced by `[REDACTED]` (recursive, depth-bounded). */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(val, depth + 1);
  }
  return out;
}

// ANSI color codes — mirrors the palette NestJS's built-in ConsoleLogger uses so our
// pretty output blends in with the framework's own `[Nest] … LOG [Context]` lines.
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  [LogLevel.ERROR]: ANSI.red,
  [LogLevel.WARN]: ANSI.yellow,
  [LogLevel.INFO]: ANSI.green,
  [LogLevel.DEBUG]: ANSI.magenta,
  [LogLevel.VERBOSE]: ANSI.cyan,
};

// NestJS prints `info` as `LOG`; match its labels so both log sources line up.
const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'LOG',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.VERBOSE]: 'VERBOSE',
};

// Keys that are rendered in the line prefix rather than the trailing metadata.
const STRUCTURAL_KEYS = new Set(['timestamp', 'level', 'context', 'message', 'trace']);

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private context: string = 'Application';
  private static logLevel: LogLevel = LogLevel.INFO;
  private static logFormat: LogFormat | null = null;

  static setLogLevel(level: LogLevel): void {
    LoggerService.logLevel = level;
  }

  // Explicitly pin the output format. When unset, the format is resolved from
  // LOG_FORMAT / TTY detection (see resolveFormat).
  static setLogFormat(format: LogFormat | null): void {
    LoggerService.logFormat = format;
  }

  setContext(context: string): void {
    this.context = context;
  }

  log(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.INFO, message, context);
  }

  error(message: string, trace?: string, context?: string | LogContext): void {
    const ctx = typeof context === 'string' ? { context } : context;
    this.writeLog(LogLevel.ERROR, message, { ...ctx, trace });
  }

  warn(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.WARN, message, context);
  }

  debug(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.DEBUG, message, context);
  }

  verbose(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.VERBOSE, message, context);
  }

  private writeLog(level: LogLevel, message: string, context?: string | LogContext): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const contextName = typeof context === 'string' ? context : this.context;
    const metadata =
      typeof context === 'object' && context !== null ? (redactSecrets(context) as Record<string, unknown>) : {};

    // Stamp every log line with the active request id (set by requestContextMiddleware) so a request
    // can be traced across logs. Absent outside a request scope (boot, workers, cron).
    const requestId = getRequestId();
    const logEntry = {
      timestamp,
      level,
      context: contextName,
      message,
      ...metadata,
      ...(requestId ? { requestId } : {}),
    };

    const output =
      LoggerService.resolveFormat() === LogFormat.PRETTY
        ? this.formatPretty(level, logEntry)
        : JSON.stringify(logEntry);

    switch (level) {
      case LogLevel.ERROR:
        console.error(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  // Render a single entry as a human-readable line in the same shape NestJS's ConsoleLogger uses
  // (so it lines up with the framework's own output), but tagged honestly as [OpenWA]:
  //   [OpenWA] 1896  - 25/06/2026, 4:59:22 PM     LOG [AuthService] API Docs: … sessionId=abc
  private formatPretty(level: LogLevel, entry: Record<string, unknown>): string {
    const useColor = LoggerService.colorEnabled();
    const paint = (code: string, text: string): string => (useColor ? `${code}${text}${ANSI.reset}` : text);

    const levelColor = LEVEL_COLOR[level];
    const label = LEVEL_LABEL[level].padStart(7);
    const timestamp = new Date(String(entry.timestamp)).toLocaleString();
    const contextName = String(entry.context);
    const message = String(entry.message);

    // Trailing structured metadata (sessionId, action, duration, …) shown dimmed as key=value pairs.
    const formatValue = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
    const meta = Object.entries(entry)
      .filter(([key, value]) => !STRUCTURAL_KEYS.has(key) && value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');

    let line =
      `${paint(levelColor, `[OpenWA] ${process.pid}  -`)} ${timestamp} ` +
      `${paint(levelColor, label)} ${paint(ANSI.yellow, `[${contextName}]`)} ${paint(levelColor, message)}`;

    if (meta) {
      line += ` ${paint(ANSI.dim, meta)}`;
    }

    // Error stack traces print on their own line(s), like NestJS.
    if (typeof entry.trace === 'string' && entry.trace) {
      line += `\n${paint(levelColor, entry.trace)}`;
    }

    return line;
  }

  private static resolveFormat(): LogFormat {
    if (LoggerService.logFormat) return LoggerService.logFormat;

    const explicit = process.env.LOG_FORMAT?.trim().toLowerCase();
    if (explicit === LogFormat.JSON || explicit === LogFormat.PRETTY) {
      return explicit;
    }

    // No explicit choice: structured JSON in production (containers, log aggregators),
    // human-readable pretty everywhere else. This mirrors NestJS's own logger, which
    // always prints its text format — and unlike a TTY check it stays correct when
    // stdout is piped through a dev runner (e.g. `concurrently` in `npm run dev`).
    return process.env.NODE_ENV === 'production' ? LogFormat.JSON : LogFormat.PRETTY;
  }

  private static colorEnabled(): boolean {
    // Honor the de-facto NO_COLOR / FORCE_COLOR conventions; otherwise colorize only a real TTY.
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return Boolean(process.stdout.isTTY);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG, LogLevel.VERBOSE];
    const currentIndex = levels.indexOf(LoggerService.logLevel);
    const targetIndex = levels.indexOf(level);
    return targetIndex <= currentIndex;
  }
}

// Create a factory for easy instantiation
export function createLogger(context: string): LoggerService {
  const logger = new LoggerService();
  logger.setContext(context);
  return logger;
}
