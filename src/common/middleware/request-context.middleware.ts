import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithRequestId } from '../services/request-context';

/**
 * Functional Express middleware: assign a request id to every inbound request, echo it on the
 * `X-Request-ID` response header, and run the entire downstream chain inside the request scope so
 * every log line and audit record can carry it (see LoggerService / AuditService).
 *
 * Accepts a sane client-supplied id (alphanumeric + dash, ≤128 chars); anything else — including a
 * CRLF header-injection attempt — is ignored and a fresh UUID is generated instead.
 */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && CLIENT_REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-ID', requestId);
  runWithRequestId(requestId, next);
}
