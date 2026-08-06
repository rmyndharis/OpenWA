package com.rmyndharis.openwa.model;

/**
 * What an invite code discloses about a group before joining.
 *
 * <p>Not {@link GroupInfo}: a non-member has no participant list, only a count, and only when
 * WhatsApp discloses one. {@code null} means the engine did not report the field.
 *
 * @param createdAt Unix seconds
 */
public record GroupJoinInfo(
    String id, String name, String description, String owner, Long createdAt, Integer participantCount) {}
