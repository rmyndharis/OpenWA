package com.rmyndharis.openwa.model;

/**
 * Weak shape returned by the GET status endpoints ({@code list}/{@code fromContact}).
 * The server payload there is loose/different; every field is optional and may be {@code null}.
 */
public record StatusRecord(
    String id,
    String statusId,
    String type,
    String body,
    /** ISO 8601 timestamp string or an epoch number, depending on the engine. */
    Object timestamp) {}
