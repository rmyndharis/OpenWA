package com.rmyndharis.openwa.model;

/**
 * Query parameters for {@code GET /search}. {@code q} is required and non-empty; all other
 * fields are optional and null fields are omitted from the request.
 *
 * <p>{@code dateFrom} / {@code dateTo} are epoch-<strong>milliseconds</strong> (the public
 * contract), even though {@link SearchHit#timestamp()} is epoch-seconds (it mirrors the stored
 * {@code messages.timestamp} column).
 *
 * <p>{@code limit} defaults to 50 and is capped at the server's {@code SEARCH_LIMIT_MAX} (100 by
 * default); {@code offset} is at most 100000, and the server answers 400 above it.
 */
public record SearchQuery(
    String q,
    SearchMatch match,
    String sessionId,
    String chatId,
    MessageDirection direction,
    String type,
    String from,
    Long dateFrom,
    Long dateTo,
    Integer limit,
    Integer offset) {
    /** Back-compatible constructor without a match mode, the server's default (word). */
    public SearchQuery(
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
        this(q, null, sessionId, chatId, direction, type, from, dateFrom, dateTo, limit, offset);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String q;
        private SearchMatch match;
        private String sessionId;
        private String chatId;
        private MessageDirection direction;
        private String type;
        private String from;
        private Long dateFrom;
        private Long dateTo;
        private Integer limit;
        private Integer offset;

        /**
         * Required. The search resource rejects a null or blank term before dispatch. At most 1000
         * characters and 32 words; the server answers 400 above either.
         */
        public Builder q(String v) {
            this.q = v;
            return this;
        }

        /** Match mode; the server defaults to {@link SearchMatch#WORD} when omitted. */
        public Builder match(SearchMatch v) {
            this.match = v;
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
            return new SearchQuery(q, match, sessionId, chatId, direction, type, from, dateFrom, dateTo, limit, offset);
        }
    }
}
