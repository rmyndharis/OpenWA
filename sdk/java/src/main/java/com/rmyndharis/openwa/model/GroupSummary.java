package com.rmyndharis.openwa.model;

/** Item returned by {@code GET /sessions/:id/groups} (the slim list shape). */
public record GroupSummary(
    String id,
    String name,
    Integer participantsCount,
    Boolean isAdmin,
    /** JID of the parent community, or {@code null} if standalone. */
    String linkedParentJID) {}
