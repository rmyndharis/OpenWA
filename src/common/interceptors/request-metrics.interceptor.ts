import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { recordHttpRequest } from '../metrics/request-metrics';

/**
 * Records one HTTP RED observation per request into the in-process request-metrics store.
 *
 * Listens for the response's `finish` (and `close`, for premature disconnects) rather than tapping
 * the handler observable, because exception filters set the final `res.statusCode` AFTER the
 * interceptor's observable chain — `finish`/`close` see the real status (2xx/4xx/5xx). The `recorded`
 * guard keeps it to one observation per request even when both events fire.
 *
 * Route label: the Express route pattern when available (bounded — `/api/sessions/:id`, not the raw
 * URL), falling back to `Controller#handler` (always available, strictly bounded).
 */
const SKIPPED_PREFIXES = ['/api/health', '/api/metrics'];

@Injectable()
export class RequestMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const route = resolveRoute(context, req);
    if (route === null || SKIPPED_PREFIXES.some(prefix => route.startsWith(prefix))) {
      return next.handle();
    }
    const method = (req.method ?? 'UNKNOWN').toUpperCase();
    const start = process.hrtime.bigint();
    let recorded = false;
    const record = (): void => {
      if (recorded) return;
      recorded = true;
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      recordHttpRequest(method, route, res.statusCode ?? 200, seconds);
    };
    res.on('finish', record);
    res.on('close', record);
    return next.handle();
  }
}

function resolveRoute(context: ExecutionContext, req: Request): string | null {
  const expressRoute = (req as unknown as { route?: { path?: string } }).route?.path;
  if (expressRoute) return expressRoute;
  try {
    const className = context.getClass()?.name;
    const handlerName = context.getHandler()?.name;
    if (className && handlerName) return `${className}#${handlerName}`;
  } catch {
    // ExecutionContext not populated for a non-HTTP caller — should not happen for a real request.
  }
  return null;
}
