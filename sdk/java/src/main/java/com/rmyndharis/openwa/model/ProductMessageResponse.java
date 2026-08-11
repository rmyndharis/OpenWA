package com.rmyndharis.openwa.model;

/**
 * Response of {@code send-product}.
 *
 * <p>The route answers with the sent message's id under {@code id}, not the {@code messageId} the
 * other send routes use.
 *
 * @param id id of the sent product message
 */
public record ProductMessageResponse(String id, long timestamp) {}
