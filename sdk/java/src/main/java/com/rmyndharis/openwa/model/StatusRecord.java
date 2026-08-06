package com.rmyndharis.openwa.model;

/**
 * One status/story from the GET status endpoints ({@code list}/{@code fromContact}), which answer a
 * {@link StatusListResult} envelope. Mirrors the backend {@code Status} — the engine payload is
 * returned as-is, with no DTO in between. Optional fields are {@code null} when absent.
 */
public record StatusRecord(
    String id,
    /** Whose story this is. */
    StatusContact contact,
    /** One of {@code text}, {@code image}, {@code video} or {@code voice}. */
    String type,
    /** Text body for a text status, caption for an image/video one. */
    String caption,
    String mediaUrl,
    String backgroundColor,
    Integer font,
    /** ISO 8601 timestamp of the post. */
    String timestamp,
    /** ISO 8601 expiry — 24h after {@code timestamp}. */
    String expiresAt) {}
