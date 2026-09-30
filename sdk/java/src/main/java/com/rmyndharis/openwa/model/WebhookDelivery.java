package com.rmyndharis.openwa.model;

import com.google.gson.JsonObject;

/**
 * The JSON body of a webhook delivery (docs/06 section 6.6). {@code event} is a string rather than
 * {@link WebhookEvent} because a delivery from the test endpoint carries {@code "test"}. Check the
 * raw body with {@link com.rmyndharis.openwa.WebhookSignature#verify(byte[], String, String)}
 * before decoding it.
 */
public record WebhookDelivery(
    String event,
    String timestamp,
    String sessionId,
    String idempotencyKey,
    String deliveryId,
    /** The event-specific payload. */
    JsonObject data) {}
