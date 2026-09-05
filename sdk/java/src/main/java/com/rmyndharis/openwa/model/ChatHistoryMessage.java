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
    MessageType type,
    /** Unix timestamp in seconds. */
    long timestamp,
    boolean fromMe,
    boolean isGroup,
    Boolean isStatusBroadcast,
    ChatKind kind,
    /** Disappearing-messages timer on the chat, in seconds; {@code null} when the chat has none. */
    Integer ephemeralDuration,
    /** For group messages, the participant who sent it ({@code from} is the group JID). */
    String author,
    List<String> mentionedIds,
    Call call,
    Boolean isLidSender,
    String senderPhone,
    Contact contact,
    /** Status/story styling. Declared by the engine payload; this route never sets either. */
    String backgroundColor,
    Integer font,
    Media media,
    QuotedMessage quotedMessage,
    Location location,
    Order order,
    Product product) {

    /** Attached media; {@code data} is absent when the payload was omitted (too large). */
    public record Media(String mimetype, String filename, String data, Boolean omitted, Long sizeBytes) {}

    public record QuotedMessage(String id, String body) {}

    public record Location(double latitude, double longitude, String description, String address, String url) {}

    /** Present on {@code call} messages only. */
    public record Call(Boolean video, Boolean missed) {}

    /**
     * Present on {@code order} messages only: the cart the customer placed from the business
     * catalog, plus the single-order {@code token} that resolves its line items.
     */
    public record Order(String orderId, String token) {}

    /** Present on {@code product} messages only: the catalog product shared into the chat. */
    public record Product(String productId, String title, String description, String businessOwnerJid) {}

    /**
     * Sender contact info. History carries {@code pushName} only; the richer fields arrive on
     * {@code message.received} when {@code WEBHOOK_CONTACT_DETAILS} is enabled.
     */
    public record Contact(
        String id,
        String number,
        String name,
        String pushName,
        String shortName,
        String type,
        Boolean isMyContact,
        Boolean isWAContact,
        Boolean isBusiness,
        Boolean isEnterprise,
        String verifiedName,
        Integer verifiedLevel,
        Boolean isBlocked,
        List<String> labels) {}
}
