package com.rmyndharis.openwa.errors;

/** 401 Unauthorized — missing or invalid API key. */
public class OpenWAAuthError extends OpenWAApiError {
    public OpenWAAuthError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
