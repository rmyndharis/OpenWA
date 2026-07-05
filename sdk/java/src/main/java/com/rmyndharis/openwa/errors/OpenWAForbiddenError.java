package com.rmyndharis.openwa.errors;

/** 403 Forbidden — the API key's role is insufficient for this endpoint. */
public class OpenWAForbiddenError extends OpenWAApiError {
    public OpenWAForbiddenError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
