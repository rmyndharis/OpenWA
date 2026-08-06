package com.rmyndharis.openwa.model;

/**
 * One participant's presence within a chat.
 *
 * @param id participant id; in a 1:1 chat this is the chat itself
 * @param state one of {@code available}, {@code unavailable}, {@code composing}, {@code recording},
 *     {@code paused} — the middle two mean actively typing or recording, {@code paused} means they stopped
 * @param lastSeen Unix SECONDS; {@code null} whenever the contact's privacy settings hide last-seen,
 *     which is the common case and not an error
 */
public record ParticipantPresence(String id, String state, Long lastSeen) {}
