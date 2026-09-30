package com.rmyndharis.openwa.errors;

import java.util.List;
import java.util.Map;

/** 403 Forbidden: the API key's role or scope (session, IP or chat allow-list) refuses the call. */
public class OpenWAForbiddenError extends OpenWAApiError {
    public OpenWAForbiddenError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }

    public OpenWAForbiddenError(
            String message, int status, Object body, String errorKind, Map<String, List<String>> headers) {
        super(message, status, body, errorKind, headers);
    }
}
