package com.rmyndharis.openwa.model;

/** A WhatsApp session. Optional fields are {@code null} when absent. */
public record SessionResponse(
    String id,
    String name,
    SessionStatus status,
    String phone,
    String pushName,
    String connectedAt,
    String lastActive,
    String createdAt,
    String updatedAt,
    /** Only present when {@code status == FAILED}. */
    String lastError) {}
