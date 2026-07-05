package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * A configured webhook. The server deliberately omits {@code secret} and
 * {@code headers} from read responses. Optional fields are {@code null} when absent.
 */
public record WebhookResponse(
    String id,
    String sessionId,
    String url,
    List<WebhookEvent> events,
    boolean active,
    WebhookFilters filters,
    int retryCount,
    /** ISO timestamp of the last delivery attempt, or {@code null} if never triggered. */
    String lastTriggeredAt,
    String createdAt,
    String updatedAt) {}
