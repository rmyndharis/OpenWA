import { Request, Response, NextFunction } from 'express';
import { recordHttpRequest } from '../metrics/request-metrics';

// Same exclusion contract as RequestMetricsInterceptor: liveness probes and the scrape endpoint
// itself are not API traffic worth a RED series.
const SKIPPED_PREFIXES = ['/api/health', '/api/metrics'];

// Bull Board is an Express app of its own mounted below /api: the labels of its routes are relative to the mount
// (`/api/queues`, read as a route the API does not have) and its UI polls every few seconds, so it is left out.
const SKIPPED_MOUNTS = ['/api/admin/queues'];

/**
 * Per-request ownership marker for the single RED observation, shared with
 * RequestMetricsInterceptor. configureApp mounts this boundary middleware on /api ahead of every
 * other middleware, so it sees every API request: the ones that middleware answers itself (the
 * shutdown 503, the in-flight budget, parser errors) and the ones the throttler (429) or the
 * API-key guard (401/403) reject before the interceptor chain ever runs. The interceptor
 * claims the requests it observes; at response time this middleware records only requests
 * left unclaimed, so every API response is counted exactly once.
 */
export const HTTP_REQUEST_METRICS_CLAIMED = Symbol('openwa.httpRequestMetricsClaimed');

type MetricsRequest = Request & { [HTTP_REQUEST_METRICS_CLAIMED]?: boolean };

/** Claim the request's single RED observation (idempotent). Used by RequestMetricsInterceptor. */
export function claimHttpRequestMetrics(req: Request): void {
  (req as MetricsRequest)[HTTP_REQUEST_METRICS_CLAIMED] = true;
}

/** Nginx's "client closed request": the connection went away before the gateway answered. */
const CLIENT_CLOSED_REQUEST = 499;

/** Where a body drop leaves the status its request is to be counted under. */
const HTTP_DROPPED_STATUS = Symbol('openwa.httpDroppedStatus');

type DroppedResponse = Response & { [HTTP_DROPPED_STATUS]?: number };

/**
 * Mark a response whose request the gateway is about to cut off (the in-flight body budget does), so the series
 * count it under `status`. Nothing is written to the client. A response that has already started is left alone: the
 * client was answered, and what it got is what counts.
 */
export function markDroppedResponse(res: Response, status: number): void {
  if (!res.headersSent) (res as DroppedResponse)[HTTP_DROPPED_STATUS] = status;
}

/**
 * The status a response is counted under when its connection closed before it finished. A drop's mark comes first:
 * cutting a multipart upload fails its parser at once, and the 500 the stack writes for that lands on the dead
 * connection before the response reports the close. Without a mark, a response that had started keeps the status it
 * sent, and one that had not was never answered because the client left while the gateway was working: 499.
 */
export function unfinishedResponseStatus(res: Response): number {
  const dropped = (res as DroppedResponse)[HTTP_DROPPED_STATUS];
  if (dropped !== undefined) return dropped;
  return res.headersSent ? res.statusCode : CLIENT_CLOSED_REQUEST;
}

export function requestMetricsBoundaryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  let finished = false;
  const record = (): void => {
    const request = req as MetricsRequest;
    if (request[HTTP_REQUEST_METRICS_CLAIMED]) return;
    request[HTTP_REQUEST_METRICS_CLAIMED] = true;
    const path = (req.originalUrl ?? '').split('?')[0];
    if (SKIPPED_MOUNTS.some(mount => path === mount || path.startsWith(`${mount}/`))) return;
    // Guard rejections happen after Express matched the route, so req.route.path carries the
    // same bounded pattern label the interceptor uses. Unmatched paths (404s) collapse into
    // one constant label — no per-URL cardinality.
    const routePath = (req as unknown as { route?: { path?: unknown } }).route?.path;
    const route = typeof routePath === 'string' ? routePath : '(unmatched)';
    if (SKIPPED_PREFIXES.some(prefix => route.startsWith(prefix))) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const status = finished ? (res.statusCode ?? 200) : unfinishedResponseStatus(res);
    recordHttpRequest((req.method ?? 'UNKNOWN').toUpperCase(), route, status, seconds);
  };
  // `finish` sees the status the exception filter wrote (the guard's 401/403/429); `close` without it means
  // the connection ended first, which unfinishedResponseStatus counts. The claim flag keeps it to one observation.
  res.on('finish', () => {
    finished = true;
    record();
  });
  res.on('close', record);
  next();
}
