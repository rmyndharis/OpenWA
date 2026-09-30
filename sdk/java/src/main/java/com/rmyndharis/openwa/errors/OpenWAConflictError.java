package com.rmyndharis.openwa.errors;

import java.util.List;
import java.util.Map;

/** 409 Conflict — typically an engine-not-ready condition from the backend. */
public class OpenWAConflictError extends OpenWAApiError {
    public OpenWAConflictError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }

    public OpenWAConflictError(
            String message, int status, Object body, String errorKind, Map<String, List<String>> headers) {
        super(message, status, body, errorKind, headers);
    }
}
