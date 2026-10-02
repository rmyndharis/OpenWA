package com.rmyndharis.openwa.model;

import java.util.List;

/** Paginated payload returned by {@code GET /sessions/:id/messages}. */
public record MessageListResponse(List<MessageRecord> messages, int total, Integer unknownTimestampTotal) {
    public MessageListResponse(List<MessageRecord> messages, int total) { this(messages, total, null); }
}
