package com.rmyndharis.openwa.errors;

/** 404 Not Found. */
public class OpenWANotFoundError extends OpenWAApiError {
    public OpenWANotFoundError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
