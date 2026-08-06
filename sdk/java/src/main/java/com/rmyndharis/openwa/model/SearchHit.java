package com.rmyndharis.openwa.model;

/**
 * A single search match returned by {@code GET /search}.
 *
 * <p>{@code snippet} carries provider-generated {@code <mark>} highlight markers; it is safe to
 * render as text but must never be injected as HTML. {@code timestamp} is Unix epoch-seconds
 * (mirrors the stored {@code messages.timestamp} column). {@code score} is null when the provider
 * did not compute a relevance rank.
 */
public record SearchHit(
    String messageId,
    String waMessageId,
    String sessionId,
    String chatId,
    String body,
    String snippet,
    Long timestamp,
    String type,
    MessageDirection direction,
    String from,
    Double score) {}
