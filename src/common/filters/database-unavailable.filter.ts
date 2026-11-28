import { ArgumentsHost, Catch, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { isEngineSendFailure } from '../errors/engine-send-failure';
import { createLogger } from '../services/logger.service';
import { isDatabaseError } from '../utils/db-errors';
import { isDatabaseUnavailable } from '../utils/recovery-queue';

/** Nothing tells the boundary whether a write took effect before the database failed, so the answer cannot either. */
export const DATABASE_UNAVAILABLE_MESSAGE =
  'The database could not serve the request; retry later. A write may already have taken effect: check before repeating it.';

const afterEffect = new WeakSet<object>();

/**
 * A statement the database rejected, which its code tells: any SQLite code that does not name a lock or an unusable
 * file, and PostgreSQL's data, constraint and syntax or access errors (SQLSTATE class 22, 23 or 42). Its text can
 * quote the caller's value, so the code decides, never the message.
 */
function isRejectedStatement(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } };
  const code = e.driverError?.code ?? e.code ?? '';
  if (code.startsWith('SQLITE_')) return !isDatabaseUnavailable({ code });
  return /^(22|23|42)/.test(code);
}

/**
 * Marks a failure raised once the request had acted (a session's engine torn down, say). It keeps the answer it had:
 * the route's own 503 says nothing was done, which no longer holds.
 */
export function markAfterEffect<T>(error: T): T {
  if (typeof error === 'object' && error !== null) afterEffect.add(error);
  return error;
}

/**
 * Answers the documented retryable 503 for a request a database could not serve (a refused or dropped connection, a
 * server starting up or out of connections, a locked SQLite file or one it cannot write to), which Nest answered with a
 * 500 that reads as a fault in the gateway. Every other error is answered as before, and so is a failure after the
 * request acted: a send whose engine call failed before the database did keeps the 500 of a failed send, as WhatsApp
 * may have taken the message, and so does one marked by markAfterEffect.
 * No Retry-After: a client may read one as proof that a write was refused before it ran.
 */
@Catch()
export class DatabaseUnavailableFilter extends BaseExceptionFilter {
  private readonly logger = createLogger('DatabaseUnavailableFilter');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (
      !isDatabaseError(exception) ||
      !isDatabaseUnavailable(exception) ||
      isRejectedStatement(exception) ||
      isEngineSendFailure(exception) ||
      afterEffect.has(exception as object)
    ) {
      super.catch(exception, host);
      return;
    }
    const request = host.switchToHttp().getRequest<Request>();
    this.logger.warn('The database could not serve a request', {
      method: request.method,
      path: request.path,
      error: String((exception as { message?: unknown }).message),
      action: 'request_database_unavailable',
    });
    super.catch(new ServiceUnavailableException(DATABASE_UNAVAILABLE_MESSAGE), host);
  }
}
