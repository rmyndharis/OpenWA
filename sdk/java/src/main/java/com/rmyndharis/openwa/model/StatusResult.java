package com.rmyndharis.openwa.model;

/**
 * Result of a status POST ({@code send-text}/{@code send-image}/{@code send-video}).
 * Mirrors the backend {@code StatusResult} exactly.
 */
public record StatusResult(
    String statusId,
    /** ISO 8601 timestamp of the post. */
    String timestamp,
    /** ISO 8601 expiry timestamp. */
    String expiresAt) {}
