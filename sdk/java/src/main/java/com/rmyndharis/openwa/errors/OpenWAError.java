package com.rmyndharis.openwa.errors;

/** Base class for every error thrown by the SDK. */
public class OpenWAError extends RuntimeException {
    public OpenWAError(String message) {
        super(message);
    }
}
