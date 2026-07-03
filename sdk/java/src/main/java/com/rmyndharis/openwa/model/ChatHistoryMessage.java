package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * A message read live from WhatsApp by {@code messages.history()}. This is the engine
 * payload (richer and differently shaped than the persisted {@link MessageRecord}).
 * Optional fields are {@code null} when absent.
 */
public record ChatHistoryMessage(
    String id,
    String from,
    String to,
    String chatId,
    String body,
    String type,
    /** Unix timestamp in seconds. */
    long timestamp,
    boolean fromMe,
    boolean isGroup,
    Boolean isStatusBroadcast,
    /** For group messages, the participant who sent it ({@code from} is the group JID). */
    String author,
    List<String> mentionedIds,
    Boolean isLidSender,
    String senderPhone,
    Media media,
    QuotedMessage quotedMessage,
    Location location) {

    /** Attached media; {@code data} is absent when the payload was omitted (too large). */
    public record Media(String mimetype, String filename, String data, Boolean omitted, Long sizeBytes) {}

    public record QuotedMessage(String id, String body) {}

    public record Location(double latitude, double longitude, String description, String address, String url) {}
}
