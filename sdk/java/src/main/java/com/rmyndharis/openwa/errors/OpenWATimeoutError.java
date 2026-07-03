package com.rmyndharis.openwa.errors;

/** Thrown when a request exceeds the configured timeout. */
public class OpenWATimeoutError extends OpenWAError {
    public OpenWATimeoutError(long timeoutMs) {
        super("Request timed out after " + timeoutMs + "ms");
    }
}
