package com.rmyndharis.openwa.model;

/**
 * A chat-list entry. Optional fields are {@code null} when absent.
 *
 * <p>{@code timestamp} is the Unix time in seconds of the last activity (unlike
 * {@code muteExpiration}, which is epoch milliseconds).
 */
public record ChatSummary(
    String id,
    String name,
    Boolean isGroup,
    Integer unreadCount,
    /** Preview text of the last message (the server returns a plain string, not an object). */
    String lastMessage,
    Long timestamp,
    ChatKind kind,
    Boolean archived,
    Boolean pinned,
    /** Whether the chat is muted right now, not the expiry behind it. */
    Boolean muted,
    /** Epoch milliseconds the mute ends, null unless muted; 0 means indefinitely. */
    Long muteExpiration,
    MessageType lastMessageType,
    /** Phone digits of a privacy-id chat, null when the chat is phone-keyed or the mapping is unknown. */
    String phone) {

    /** Construct a chat summary without last-message type metadata or a resolved phone. */
    public ChatSummary(
        String id, String name, Boolean isGroup, Integer unreadCount, String lastMessage,
        Long timestamp, ChatKind kind, Boolean archived, Boolean pinned, Boolean muted,
        Long muteExpiration) {
        this(id, name, isGroup, unreadCount, lastMessage, timestamp, kind, archived, pinned,
            muted, muteExpiration, null, null);
    }

    /** Construct a chat summary without a resolved phone. */
    public ChatSummary(
        String id, String name, Boolean isGroup, Integer unreadCount, String lastMessage,
        Long timestamp, ChatKind kind, Boolean archived, Boolean pinned, Boolean muted,
        Long muteExpiration, MessageType lastMessageType) {
        this(id, name, isGroup, unreadCount, lastMessage, timestamp, kind, archived, pinned,
            muted, muteExpiration, lastMessageType, null);
    }
}
