package com.rmyndharis.openwa.model;

import java.util.List;

/** Full detail returned by {@code GET /sessions/:id/groups/:groupId}. */
public record GroupInfo(
    String id,
    String name,
    String description,
    String owner,
    /** Unix timestamp in seconds. */
    Long createdAt,
    List<GroupParticipant> participants,
    Boolean isReadOnly,
    Boolean isAnnounce,
    String linkedParentJID) {}
