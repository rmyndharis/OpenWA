package com.rmyndharis.openwa.model;

/**
 * A chat-list entry. Optional fields are {@code null} when absent.
 *
 * <p>{@code timestamp} is loosely typed on the wire (string or number), so it is
 * exposed as {@link Object}.
 */
public record ChatSummary(
    String id,
    String name,
    Boolean isGroup,
    Integer unreadCount,
    /** Preview text of the last message (the server returns a plain string, not an object). */
    String lastMessage,
    Object timestamp) {}
