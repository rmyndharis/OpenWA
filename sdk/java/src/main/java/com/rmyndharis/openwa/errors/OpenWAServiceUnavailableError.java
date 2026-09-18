package com.rmyndharis.openwa.errors;

/**
 * 503 Service Unavailable — a transport failure, not a refusal.
 *
 * <p>The gateway answers this when the engine did not confirm the operation in time: WhatsApp never
 * replied, the socket was down, or the request budget ran out. <b>Retryable</b>, unlike every other
 * typed error here. The non-idempotent sends are deliberately left unbounded by the gateway so a slow
 * WhatsApp reply never answers one, and in a multi-node deployment a forwarded request answers 503
 * only when the owner node was never reached. A forward that fails after the request was sent
 * answers 502 or 504 instead (a plain {@link OpenWAApiError}): the owner may already have carried it
 * out, so do not repeat a non-idempotent send on those unchecked.
 */
public class OpenWAServiceUnavailableError extends OpenWAApiError {
    public OpenWAServiceUnavailableError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
