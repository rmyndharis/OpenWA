package com.rmyndharis.openwa.errors;

/**
 * Base class for errors the SDK throws for an API response, a timeout or a transport failure. An invalid
 * argument (an empty or dot id, an invalid idempotency key or client option) throws
 * {@link IllegalArgumentException} instead.
 */
public class OpenWAError extends RuntimeException {
    public OpenWAError(String message) {
        super(message);
    }

    public OpenWAError(String message, Throwable cause) {
        super(message, cause);
    }
}
