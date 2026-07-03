package com.rmyndharis.openwa.model;

/** A WhatsApp Channel / Newsletter. Optional fields are {@code null} when absent. */
public record ChannelRecord(
    String id,
    String name,
    String description,
    Integer subscriberCount,
    String pictureUrl,
    String role) {}
