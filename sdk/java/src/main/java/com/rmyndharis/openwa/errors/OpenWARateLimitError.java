package com.rmyndharis.openwa.errors;

import java.util.List;
import java.util.Map;

/**
 * 429 Too Many Requests — rate limited.
 *
 * <p>The global rate limiter's 429 lifts when its window expires (seconds for the per-second tier,
 * up to an hour for the hourly tier by default), and {@link #retryAfterSeconds()} carries its
 * {@code Retry-After} header. A 429 whose {@link #code()} is {@code "SEND_PACING_LIMITED"} is not
 * transient: do not retry it before {@link #retryAfterSeconds()}, which then comes from the body and
 * can be hours.
 */
public class OpenWARateLimitError extends OpenWAApiError {
    public OpenWARateLimitError(String message, int status, Object body, String errorKind) {
        super(message, status, body, errorKind);
    }

    public OpenWARateLimitError(
            String message, int status, Object body, String errorKind, Map<String, List<String>> headers) {
        super(message, status, body, errorKind, headers);
    }
}
