package com.rmyndharis.openwa.model;

/**
 * A contact known to a session. Optional fields are {@code null} when absent.
 *
 * <p>{@code isBlocked} is best-effort: the Baileys adapter does not track blocklist state and always
 * reports false.
 */
public record ContactRecord(
    String id,
    String name,
    String number,
    String pushName,
    Boolean isMyContact,
    Boolean isBlocked,
    String profilePicUrl) {}
