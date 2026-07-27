import { Request, Response, NextFunction } from 'express';
import { recordHttpRequest } from '../metrics/request-metrics';

// Same exclusion contract as RequestMetricsInterceptor: liveness probes and the scrape endpoint
// itself are not API traffic worth a RED series.
const SKIPPED_PREFIXES = ['/api/health', '/api/metrics'];

/**
 * Per-request ownership marker for the single RED observation, shared with
 * RequestMetricsInterceptor. Nest runs middleware BEFORE guards and interceptors, so this
 * boundary middleware sees every API request — including ones the throttler (429) or the
 * API-key guard (401/403) reject before the interceptor chain ever runs. The interceptor
 * claims the requests it observes; at response time this middleware records only requests
 * left unclaimed, so every response is counted exactly once.
 */
export const HTTP_REQUEST_METRICS_CLAIMED = Symbol('openwa.httpRequestMetricsClaimed');

type MetricsRequest = Request & { [HTTP_REQUEST_METRICS_CLAIMED]?: boolean };

/** Claim the request's single RED observation (idempotent). Used by RequestMetricsInterceptor. */
export function claimHttpRequestMetrics(req: Request): void {
  (req as MetricsRequest)[HTTP_REQUEST_METRICS_CLAIMED] = true;
}

export function requestMetricsBoundaryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const record = (): void => {
    const request = req as MetricsRequest;
    if (request[HTTP_REQUEST_METRICS_CLAIMED]) return;
    request[HTTP_REQUEST_METRICS_CLAIMED] = true;
    // Guard rejections happen after Express matched the route, so req.route.path carries the
    // same bounded pattern label the interceptor uses. Unmatched paths (404s) collapse into
    // one constant label — no per-URL cardinality.
    const routePath = (req as unknown as { route?: { path?: unknown } }).route?.path;
    const route = typeof routePath === 'string' ? routePath : '(unmatched)';
    if (SKIPPED_PREFIXES.some(prefix => route.startsWith(prefix))) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    recordHttpRequest((req.method ?? 'UNKNOWN').toUpperCase(), route, res.statusCode ?? 200, seconds);
  };
  // `finish` sees the status the exception filter wrote (the guard's 401/403/429); `close`
  // covers a premature client disconnect. The claim flag keeps it to one observation.
  res.on('finish', record);
  res.on('close', record);
  next();
}
