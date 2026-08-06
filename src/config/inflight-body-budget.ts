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
 * ALL connections — the declared Content-Length where present, one budget slot otherwise — and
 * refuses NEW requests with 503 + Retry-After once the budget is exhausted, without reading a
 * single byte of the rejected body.
 *
 * The bound is on WIRE bytes, and it holds as heap only while a body is stored as it arrives.
 * A compressed body would break that — admitted at its compressed length, then inflated by the
 * parser into memory nothing accounted for — so a non-identity Content-Encoding is refused with
 * 415 outright rather than priced. The remaining looseness in the wire-byte ACCOUNTING is
 * deliberate and bounded: a chunked identity body reserves a placeholder and is reconciled against
 * socket.bytesRead on the poll interval, so it can briefly under-report by the bytes that arrive
 * within one interval. Separately, and by design, an admitted identity body still costs a constant
 * multiple of its wire size once parsed (the raw Buffer pinned on rawBody, plus the decoded string
 * and the parsed object) — the budget bounds the input, not the parse.
 *
 * A stalled sender (headers, then silence) holds its
 * reservation only until the stall reaper drops the socket after STALL_TIMEOUT_MS without any
 * new body bytes, so a handful of silent connections cannot pin the whole budget. The request
 * stream itself is never tapped — no 'data' listener — so downstream consumers (the body
 * parser, busboy) see every chunk exactly as it arrives, even when they attach late.
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
 * Stall reaper. A reservation is normally released when the response finishes or the connection
 * dies — but a socket that sends headers and then goes silent fires NEITHER, so without a reaper
 * it would hold its declared bytes until Node's requestTimeout (5 minutes by default), and four
 * such connections at the per-request cap would pin the entire default budget, renewable forever.
 * Any admitted request expecting a body is therefore polled: if no new body bytes arrive for
 * STALL_TIMEOUT_MS the socket is destroyed and the reservation released. Polling (rather than one
 * fixed deadline) lets any progress reset the clock, so slow-but-moving uploads are untouched.
 */
const STALL_TIMEOUT_MS = 15_000;
const STALL_POLL_MS = 5_000;

/**
 * What a chunked (undeclared-length) body reserves before any of it has arrived. The same poll that
 * watches for a stall also reconciles this against `socket.bytesRead`, so the reservation converges
 * on the real size within one interval — this only has to be big enough that admission control is
 * not a free-for-all, not big enough to price a small upload out of the budget.
 */
const UNDECLARED_OPENING_RESERVATION_BYTES = 1024 * 1024;

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
  // Opening reservation for a body with no declared length (chunked). It is only a placeholder:
  // the poller below reconciles it against the bytes that actually arrive, so a small chunked
  // request ends up costing what it really weighs. Reserving a whole per-request cap up front
  // instead would make the budget a concurrency limit of DEFAULT_BUDGET_MULTIPLIER for chunked
  // senders — four 6-byte uploads would refuse every further body-carrying request.
  const undeclaredReservation = Math.max(1, Math.min(UNDECLARED_OPENING_RESERVATION_BYTES, budgetBytes));

  // The rejected request's body is deliberately NEVER read. 'Connection: close' tells the client
  // (and Node) this socket dies with the response, so the unread bytes are discarded with the
  // socket instead of being misread as the next pipelined request on a keep-alive connection.
  const rejectBusy = (req: Request, res: Response): void => {
    // Another listener may already have started an early response (e.g. a guard's 401 flushing
    // while the body still streams in); writing the 503 then throws ERR_HTTP_HEADERS_SENT from
    // inside a raw listener. Dropping the socket is the only safe rejection left.
    if (res.headersSent || res.writableEnded) {
      req.destroy();
      return;
    }
    res
      .status(503)
      .set('Retry-After', retryAfter)
      .set('Connection', 'close')
      .json({ statusCode: 503, message: 'Too much request body data in flight; retry later' });
  };

  /** Same never-read-the-body disposal as rejectBusy; only the reason and status differ. */
  const rejectCompressed = (req: Request, res: Response): void => {
    if (res.headersSent || res.writableEnded) {
      req.destroy();
      return;
    }
    res.status(415).set('Connection', 'close').json({
      statusCode: 415,
      message: 'Compressed request bodies are not supported',
      error: 'Unsupported Media Type',
    });
  };

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const declared = parseDeclaredLength(req.headers['content-length']);
    // A body with no declared length is expected only when the request is chunk-encoded (Node
    // ignores close-delimited request bodies on keep-alive HTTP/1.1). Anything else — GETs,
    // health checks, Content-Length: 0 — reserves nothing and is never reaped.
    let reserved = declared ?? (req.headers['transfer-encoding'] !== undefined ? undeclaredReservation : 0);

    // Every quantity this budget works with — the declared length, and socket.bytesRead in the
    // reconciler below — is a WIRE measurement, while what the budget exists to bound is HEAP. The
    // two are the same size only while the body is stored as it arrives. A compressed body breaks
    // that: it is admitted on its compressed length and then inflated by the parser, so a payload
    // orders of magnitude larger than the whole budget can be buffered without the accounting ever
    // seeing it. Refusing here — before admission, before a byte is read — keeps the invariant
    // true rather than trying to price an expansion that is not knowable in advance.
    //
    // The predicate is body-parser's, NOT `reserved > 0`. They disagree on exactly the cases that
    // matter: `parseDeclaredLength` rejects a Content-Length that is not a safe integer (reserving
    // nothing), while type-is `hasBody` accepts anything non-NaN — so `Content-Length: 2**53 + 1`
    // with a gzip body reserves 0 here yet is still handed to the parser. Mirroring hasBody keeps
    // the two layers from disagreeing about whether a body exists.
    const bodyIndicated =
      req.headers['transfer-encoding'] !== undefined || !Number.isNaN(Number(req.headers['content-length']));
    // The accepted set is body-parser's, deliberately: it compares the WHOLE header against
    // 'identity', so even a technically-uncompressed list ("identity, identity") is refused there.
    // Accepting more here would only move the refusal to the parser, which answers a different
    // shape — the two layers agreeing matters more than honouring an encoding list nobody sends.
    const encoding = (req.headers['content-encoding'] ?? '').trim().toLowerCase();
    if (bodyIndicated && encoding !== '' && encoding !== 'identity') {
      rejectCompressed(req, res);
      return;
    }

    // Admission control on the RESERVED size: a request that would push the aggregate past the
    // budget is refused before a single byte of its body is buffered.
    if (inFlightBytes + reserved > budgetBytes) {
      rejectBusy(req, res);
      return;
    }

    inFlightBytes += reserved;

    let released = false;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const disarmStallReaper = (): void => {
      if (stallTimer === undefined) return;
      clearInterval(stallTimer);
      stallTimer = undefined;
    };

    // Exactly-once release: the first terminal event wins — normal completion (res 'finish'),
    // client/socket abort (req/res 'close'), stream failure (req/res 'error'). An aborted upload
    // typically fires several of these; the flag guarantees the aggregate is decremented once.
    const release = (): void => {
      if (released) return;
      released = true;
      disarmStallReaper();
      inFlightBytes -= reserved;
    };
    res.on('finish', release);
    res.on('close', release);
    res.on('error', release);
    req.on('close', release);
    req.on('error', release);

    if (reserved > 0) {
      // Stall reaper (see STALL_TIMEOUT_MS above). Progress is measured on the SOCKET byte
      // counter, never on the request stream: attaching a 'data' listener would switch the
      // stream to flowing mode and eat chunks before a late consumer (the async guards run
      // before busboy/body-parser attach) ever sees them. 'end' is safe to observe — it does
      // not start the flow — and disarms the reaper once the real consumer finished reading.
      const socket = req.socket;
      const startBytes = socket.bytesRead;
      let lastBytes = startBytes;
      let lastProgress = Date.now();

      // Undeclared length: replace the opening placeholder with what has actually arrived, so a
      // small chunked upload stops holding a big reservation and a large one is accounted honestly.
      // Crossing the budget mid-stream aborts the request — the same bound a declared length gets
      // at admission, applied to a sender that declined to declare one.
      const reconcileUndeclared = (readNow: number): void => {
        const actual = Math.max(undeclaredReservation, readNow - startBytes);
        if (actual === reserved) return;
        inFlightBytes += actual - reserved;
        reserved = actual;
        if (inFlightBytes > budgetBytes) {
          release();
          req.destroy();
        }
      };

      stallTimer = setInterval(() => {
        // The whole message is in (Node parsed it to the end) — there is nothing left to stall on,
        // whether or not any consumer has read it. Without this a body that arrived in one segment
        // before this middleware ran would keep the reaper armed on a byte counter that can no
        // longer move, and a handler slower than STALL_TIMEOUT_MS would be killed mid-work.
        if (req.complete) {
          disarmStallReaper();
          return;
        }
        const readNow = socket.bytesRead;
        if (readNow !== lastBytes) {
          if (declared === undefined) reconcileUndeclared(readNow);
          lastBytes = readNow;
          lastProgress = Date.now();
          // The whole declared body has arrived; nothing left to stall on.
          if (declared !== undefined && readNow - startBytes >= declared) disarmStallReaper();
          return;
        }
        if (Date.now() - lastProgress >= STALL_TIMEOUT_MS) {
          release();
          req.destroy();
        }
      }, STALL_POLL_MS);
      stallTimer.unref();
      req.on('end', disarmStallReaper);
    }

    next();
  };

  return { middleware, currentBytes: () => inFlightBytes };
}

/** A well-formed Content-Length, or undefined when absent/unusable (then reserve one slot if chunk-encoded). */
function parseDeclaredLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
