/**
 * Aggregate in-flight request-body budget.
 *
 * The per-request body cap (BODY_SIZE_LIMIT, enforced by the body parser) bounds ONE upload but
 * says nothing about how many bodies may be buffered at once: N connections each trickling a
 * near-limit body pin N × limit bytes of memory before any guard ever runs — the Nest throttler /
 * auth guards sit at the routing layer, AFTER middleware and body buffering, so they cannot see
 * slow-body memory pinning. With a 25 MiB per-request cap, a hundred slow senders is enough to
 * push a 2 GiB container out of memory.
 *
 * This middleware closes the gap. It tracks the aggregate body bytes currently in flight across
 * ALL connections — the declared Content-Length where present, the actual received bytes
 * otherwise — and refuses NEW requests with 503 + Retry-After once the budget is exhausted,
 * without reading a single byte of the rejected body. Requests with no Content-Length (chunked /
 * close-delimited) are admitted, counted as their bytes actually arrive, and aborted mid-stream
 * if they push the aggregate over the budget, so un-declared tricklers cannot bypass the cap.
 *
 * Extracted from main.ts so the accounting — notably the exactly-once release across every
 * terminal path — is unit-tested without booting the app.
 */
import { Request, Response, NextFunction } from 'express';
import { resolveBodyLimit } from './bootstrap-security';

/**
 * Default budget = 4 × the per-request body cap: a handful of concurrent full-size media uploads
 * (base64 rides in the JSON body) still fits, while the worst-case aggregate (~100 MiB with the
 * default 25 MiB cap) stays small next to a 2 GiB container limit and realistic concurrency.
 */
const DEFAULT_BUDGET_MULTIPLIER = 4;

/** Binary units, mirroring the semantics of the `bytes` package the body parser uses. */
const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
};

const FALLBACK_LIMIT_BYTES = 25 * UNIT_BYTES.mb;

/**
 * Parse a body-limit string ('25mb', '1024', '1.5gb') into bytes. Only the formats
 * resolveBodyLimit accepts are supported, which keeps this module self-contained (no extra
 * dependency); an impossible mismatch falls back to the same 25 MiB default instead of throwing.
 */
export function parseBodyLimitBytes(limit: string): number {
  const match = /^(\d+(?:\.\d+)?)\s?(b|kb|mb|gb|tb|pb)?$/i.exec(limit.trim());
  if (!match) return FALLBACK_LIMIT_BYTES;
  return Math.floor(parseFloat(match[1]) * UNIT_BYTES[(match[2] ?? 'b').toLowerCase()]);
}

/**
 * Resolve the aggregate budget in bytes. An explicit INFLIGHT_BODY_BUDGET_BYTES (positive integer)
 * wins; an invalid one falls back to the default — env.validation already rejects it at boot, so
 * this is the same fail-safe layering as the other byte knobs. The default scales with
 * BODY_SIZE_LIMIT so tuning the per-request cap keeps the aggregate proportional.
 */
export function resolveInflightBodyBudgetBytes(budgetEnv?: string, bodyLimitEnv?: string): number {
  const raw = budgetEnv?.trim();
  if (raw) {
    const explicit = Number(raw);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
  }
  return DEFAULT_BUDGET_MULTIPLIER * parseBodyLimitBytes(resolveBodyLimit(bodyLimitEnv));
}

export interface InflightBodyBudgetOptions {
  /** Retry-After value (seconds) sent with the 503. Default 1 — budget frees as bodies finish. */
  retryAfterSeconds?: number;
}

export interface InflightBodyBudget {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Aggregate bytes currently attributed to in-flight request bodies (observability/tests). */
  currentBytes: () => number;
}

export function createInflightBodyBudget(budgetBytes: number, options?: InflightBodyBudgetOptions): InflightBodyBudget {
  let inFlightBytes = 0;
  const retryAfter = String(options?.retryAfterSeconds ?? 1);

  // The rejected request's body is deliberately NEVER read. 'Connection: close' tells the client
  // (and Node) this socket dies with the response, so the unread bytes are discarded with the
  // socket instead of being misread as the next pipelined request on a keep-alive connection.
  const rejectBusy = (res: Response): void => {
    res
      .status(503)
      .set('Retry-After', retryAfter)
      .set('Connection', 'close')
      .json({ statusCode: 503, message: 'Too much request body data in flight; retry later' });
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const declared = parseDeclaredLength(req.headers['content-length']);

    // Admission control on the DECLARED size: a request that would push the aggregate past the
    // budget is refused before a single byte of its body is buffered.
    if (declared !== undefined && inFlightBytes + declared > budgetBytes) {
      rejectBusy(res);
      return;
    }

    let counted = declared ?? 0;
    inFlightBytes += counted;

    // Exactly-once release: the first terminal event wins — normal completion (res 'finish'),
    // client/socket abort (req/res 'close'), stream failure (req/res 'error'). An aborted upload
    // typically fires several of these; the flag guarantees the aggregate is decremented once.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlightBytes -= counted;
    };
    res.on('finish', release);
    res.on('close', release);
    res.on('error', release);
    req.on('close', release);
    req.on('error', release);

    if (declared === undefined) {
      // No Content-Length (chunked / close-delimited): nothing to reserve up front, so count
      // bytes as they actually arrive. The mid-stream abort keeps the aggregate bounded even
      // when every sender avoids declaring a length. The stream stays intact for the downstream
      // body parser — 'data' listeners observe the same chunks, they do not consume them away.
      req.on('data', (chunk: Buffer) => {
        if (released) return; // already aborted below — stop counting, the 503 is on its way
        counted += chunk.length;
        inFlightBytes += chunk.length;
        if (inFlightBytes > budgetBytes) {
          release();
          rejectBusy(res);
        }
      });
    }

    next();
  };

  return { middleware, currentBytes: () => inFlightBytes };
}

/** A well-formed Content-Length, or undefined when absent/unusable (then count actual bytes). */
function parseDeclaredLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
