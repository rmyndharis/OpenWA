package com.rmyndharis.openwa.model;

/** A member of a WhatsApp group. Optional fields are {@code null} when absent. */
public record GroupParticipant(
    String id,
    String number,
    String name,
    boolean isAdmin,
    boolean isSuperAdmin) {}
