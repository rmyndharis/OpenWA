package com.rmyndharis.openwa.errors;

/**
 * Thrown when a request exceeds the configured timeout. The gateway may still complete the request:
 * retry a send only with the same {@code Idempotency-Key}, and re-read state before repeating any
 * other write.
 */
public class OpenWATimeoutError extends OpenWAError {
    public OpenWATimeoutError(long timeoutMs) {
        super("Request timed out after " + timeoutMs + "ms");
    }
}
