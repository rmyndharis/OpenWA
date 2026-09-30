package com.rmyndharis.openwa.errors;

import java.util.List;
import java.util.Map;

/** 501 Not Implemented — the active engine does not support this operation. */
public class OpenWANotImplementedError extends OpenWAApiError {
    public OpenWANotImplementedError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }

    public OpenWANotImplementedError(
            String message, int status, Object body, String errorKind, Map<String, List<String>> headers) {
        super(message, status, body, errorKind, headers);
    }
}
