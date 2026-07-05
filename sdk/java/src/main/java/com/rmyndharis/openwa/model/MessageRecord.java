package com.rmyndharis.openwa.model;

import java.util.Map;

/**
 * A persisted message row, as returned by {@code GET /sessions/:id/messages}.
 * Optional fields are {@code null} when absent.
 */
public record MessageRecord(
    String id,
    String sessionId,
    /** Engine/WhatsApp message id; may be {@code null} until a send is acked. */
    String waMessageId,
    String chatId,
    String from,
    String to,
    String body,
    String type,
    MessageDirection direction,
    /** Unix timestamp in seconds. */
    Long timestamp,
    Map<String, Object> metadata,
    DeliveryStatus status,
    String createdAt) {}
