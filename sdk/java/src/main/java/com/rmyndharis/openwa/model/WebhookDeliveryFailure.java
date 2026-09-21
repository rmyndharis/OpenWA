package com.rmyndharis.openwa.model;

/**
 * A webhook delivery abandoned after every retry, as listed by the delivery-failure log. Optional
 * fields are {@code null} when absent.
 */
public record WebhookDeliveryFailure(
    String id,
    String webhookId,
    String sessionId,
    String event,
    String url,
    /** The idempotency key the receiver would have deduped on. */
    String idempotencyKey,
    String deliveryId,
    /** Total attempts made before giving up. */
    int attempts,
    /** Last HTTP status when the failure was a non-2xx response; {@code null} for a network or timeout error. */
    Integer lastStatusCode,
    String lastError,
    /** ISO timestamp of when the delivery was finally abandoned. */
    String createdAt) {}
