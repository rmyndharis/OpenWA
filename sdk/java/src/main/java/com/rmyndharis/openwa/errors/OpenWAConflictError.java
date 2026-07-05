package com.rmyndharis.openwa.errors;

/** 409 Conflict — typically an engine-not-ready condition from the backend. */
public class OpenWAConflictError extends OpenWAApiError {
    public OpenWAConflictError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
