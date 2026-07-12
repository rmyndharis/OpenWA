/**
 * HTTP server timeout configuration + a pure applicator.
 *
 * Extracted from `main.ts` so the resolution rule (notably "headersTimeout must exceed
 * keepAliveTimeout", which Node otherwise warns about and self-corrects invisibly) is unit-tested
 * without booting the whole app.
 */
export interface HttpTimeoutConfig {
  /** Hard cap on the full request duration (Node's `server.requestTimeout`). */
  requestTimeoutMs: number;
  /** Cap on receiving the request headers (Node's `server.headersTimeout`). */
  headersTimeoutMs: number;
  /** Idle keep-alive duration between requests on one connection (Node's `server.keepAliveTimeout`). */
  keepAliveTimeoutMs: number;
}

/** The values actually written, after any normalization. */
export type HttpTimeoutReport = HttpTimeoutConfig;

/** The subset of `http.Server` this helper touches (keeps the helper testable with a plain object). */
export interface HttpTimeoutSink {
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
}

/**
 * Write the configured timeouts onto the server and return the resolved values (which may differ
 * from the request when headersTimeout had to be bumped above keepAliveTimeout). Boot logs the
 * returned report so the applied values are observable.
 */
export function applyHttpTimeouts(server: HttpTimeoutSink, cfg: HttpTimeoutConfig): HttpTimeoutReport {
  const requestTimeoutMs = Math.floor(cfg.requestTimeoutMs);
  const keepAliveTimeoutMs = Math.floor(cfg.keepAliveTimeoutMs);
  const requestedHeadersMs = Math.floor(cfg.headersTimeoutMs);
  // Node requires headersTimeout > keepAliveTimeout (it logs a warning and self-corrects otherwise,
  // which is invisible to the operator). Bump by a second rather than failing boot — the point is to
  // make the applied values correct and observable.
  const headersTimeoutMs = requestedHeadersMs > keepAliveTimeoutMs ? requestedHeadersMs : keepAliveTimeoutMs + 1000;

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;

  return { requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs };
}
