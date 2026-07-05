package com.rmyndharis.openwa.errors;

/** 501 Not Implemented — the active engine does not support this operation. */
public class OpenWANotImplementedError extends OpenWAApiError {
    public OpenWANotImplementedError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }
}
