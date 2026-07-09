package com.rmyndharis.openwa.model;

/**
 * Query parameters for {@code GET /search}. {@code q} is required and non-empty; all other
 * fields are optional and null fields are omitted from the request.
 *
 * <p>{@code dateFrom} / {@code dateTo} are epoch-<strong>milliseconds</strong> (the public
 * contract), even though {@link SearchHit#timestamp()} is epoch-seconds (it mirrors the stored
 * {@code messages.timestamp} column).
 */
public record SearchQuery(
    String q,
    String sessionId,
    String chatId,
    MessageDirection direction,
    String type,
    String from,
    Long dateFrom,
    Long dateTo,
    Integer limit,
    Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String q;
        private String sessionId;
        private String chatId;
        private MessageDirection direction;
        private String type;
        private String from;
        private Long dateFrom;
        private Long dateTo;
        private Integer limit;
        private Integer offset;

        /** Required. The search term; must be non-empty at {@link #build()} time. */
        public Builder q(String v) {
            this.q = v;
            return this;
        }

        public Builder sessionId(String v) {
            this.sessionId = v;
            return this;
        }

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder direction(MessageDirection v) {
            this.direction = v;
            return this;
        }

        public Builder type(String v) {
            this.type = v;
            return this;
        }

        public Builder from(String v) {
            this.from = v;
            return this;
        }

        public Builder dateFrom(Long v) {
            this.dateFrom = v;
            return this;
        }

        public Builder dateTo(Long v) {
            this.dateTo = v;
            return this;
        }

        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public Builder offset(Integer v) {
            this.offset = v;
            return this;
        }

        public SearchQuery build() {
            return new SearchQuery(q, sessionId, chatId, direction, type, from, dateFrom, dateTo, limit, offset);
        }
    }
}
