import { EngineTransportError } from './engine-transport.error';

/**
 * An {@link EngineTransportError} (HTTP 503) for a send that failed in transport before the message was
 * handed to WhatsApp, such as a lookup the send depends on timing out. Like a throttled request, nothing
 * went out, while a plain EngineTransportError leaves the outcome unknown, so a paced send can give its
 * admission back.
 */
export class EngineNotSentError extends EngineTransportError {}

/** Errors raised before anything was handed to WhatsApp, whatever their HTTP status. */
const raisedBeforeSend = new WeakSet<object>();

/**
 * Record that an error was raised before anything was handed to WhatsApp, keeping its own status and body:
 * media that could not be fetched or read is the caller's 400 or 413, yet proves what EngineNotSentError
 * proves, so a keyed send frees its `Idempotency-Key` for it the same way.
 */
export function markNothingSent<T>(error: T): T {
  if (error !== null && typeof error === 'object') raisedBeforeSend.add(error);
  return error;
}

/** Whether an error proves nothing was handed to WhatsApp: an EngineNotSentError, or one markNothingSent recorded. */
export function provesNothingSent(error: unknown): boolean {
  return (
    error instanceof EngineNotSentError || (error !== null && typeof error === 'object' && raisedBeforeSend.has(error))
  );
}
