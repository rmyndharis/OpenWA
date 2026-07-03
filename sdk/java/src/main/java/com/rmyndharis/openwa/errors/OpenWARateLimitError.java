package com.rmyndharis.openwa.errors;

/** 429 Too Many Requests — rate limited. */
public class OpenWARateLimitError extends OpenWAApiError {
    public OpenWARateLimitError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
