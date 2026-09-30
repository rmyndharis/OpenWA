package com.rmyndharis.openwa.errors;

import java.util.List;
import java.util.Map;

/** 404 Not Found. */
public class OpenWANotFoundError extends OpenWAApiError {
    public OpenWANotFoundError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }

    public OpenWANotFoundError(
            String message, int status, Object body, String errorKind, Map<String, List<String>> headers) {
        super(message, status, body, errorKind, headers);
    }
}
