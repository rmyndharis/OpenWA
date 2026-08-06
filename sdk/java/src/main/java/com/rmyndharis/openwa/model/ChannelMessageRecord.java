package com.rmyndharis.openwa.model;

/**
 * A message read live from a channel by {@code channels.messages()}. This is the engine payload
 * (backend {@code ChannelMessage}), NOT the persisted {@link MessageRecord} — that endpoint reads
 * WhatsApp directly and never touches the message store. Optional fields are {@code null} when
 * absent.
 */
public record ChannelMessageRecord(
    String id,
    String body,
    /** Unix timestamp in seconds. */
    Long timestamp,
    Boolean hasMedia,
    String mediaUrl) {}
