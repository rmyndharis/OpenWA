package com.rmyndharis.openwa.errors;

/**
 * 503 Service Unavailable — a transport failure, not a refusal.
 *
 * <p>The gateway answers this when the engine did not confirm the operation in time: WhatsApp never
 * replied, the socket was down, or the request budget ran out. <b>Retryable</b>, unlike every other
 * typed error here. The non-idempotent sends are deliberately left unbounded by the gateway so they
 * never answer one.
 */
public class OpenWAServiceUnavailableError extends OpenWAApiError {
    public OpenWAServiceUnavailableError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
