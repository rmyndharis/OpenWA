package com.rmyndharis.openwa.model;

/**
 * One status/story from the GET status endpoints ({@code list}/{@code fromContact}), which answer a
 * {@link StatusListResult} envelope. Mirrors the backend {@code Status} — the engine payload is
 * returned as-is, with no DTO in between. Optional fields are {@code null} when absent.
 *
 * <p>{@code mediaUrl}, {@code backgroundColor} and {@code font} are declared by the backend but no
 * engine populates them on a read yet: whatsapp-web.js maps none of them, and Baileys cannot read
 * statuses at all. They are here for forward compatibility — do not expect them on a response today.
 */
public record StatusRecord(
    String id,
    /** Whose story this is. */
    StatusContact contact,
    /** One of {@code text}, {@code image} or {@code video}. */
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
