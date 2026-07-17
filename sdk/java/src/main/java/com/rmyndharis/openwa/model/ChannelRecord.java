package com.rmyndharis.openwa.model;

/**
 * A WhatsApp Channel / Newsletter. Mirrors the backend {@code Channel} — returned by the engine
 * as-is, with no DTO in between. Optional fields are {@code null} when absent.
 */
public record ChannelRecord(
    String id,
    String name,
    String description,
    /** Invite code from the channel link. */
    String inviteCode,
    Integer subscriberCount,
    /** Channel picture URL. Populated by Baileys; whatsapp-web.js omits it. */
    String picture,
    Boolean verified,
    /** Channel creation time as reported by the engine. Populated by Baileys; whatsapp-web.js omits it. */
    Long createdAt) {}
