package com.rmyndharis.openwa.model;

/** Query parameters for {@code GET /sessions/:id/messages}. Null fields are omitted. */
public record ListMessagesQuery(
        String chatId, String from, Integer limit, Integer offset, String after, Boolean inlineMedia,
        Double since, Double until, String direction, String orderBy, String type, String messageId) {
    public ListMessagesQuery(String chatId, String from, Integer limit, Integer offset, String after, Boolean inlineMedia) {
        this(chatId, from, limit, offset, after, inlineMedia, null, null, null, null, null, null);
    }
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String from;
        private Integer limit;
        private Integer offset;
        private String after;
        private Boolean inlineMedia;
        private Double since;
        private Double until;
        private String direction;
        private String orderBy;
        private String type;
        private String messageId;
        public Builder messageId(String v) { this.messageId = v; return this; }
        public Builder type(String v) { this.type = v; return this; }

        /** Inclusive message-time lower bound, Unix epoch milliseconds. */
        public Builder since(Double v) { this.since = v; return this; }
        /** Exclusive message-time upper bound, Unix epoch milliseconds. */
        public Builder until(Double v) { this.until = v; return this; }
        public Builder direction(String v) { this.direction = v; return this; }
        public Builder orderBy(String v) { this.orderBy = v; return this; }

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder from(String v) {
            this.from = v;
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

        /** Keyset cursor: the id of the last message of the previous page. Takes precedence over offset. */
        public Builder after(String v) {
            this.after = v;
            return this;
        }

        /** Set false to omit inline media payloads; the budget is per response, so a walk repays it per page. */
        public Builder inlineMedia(Boolean v) {
            this.inlineMedia = v;
            return this;
        }

        public ListMessagesQuery build() {
            return new ListMessagesQuery(chatId, from, limit, offset, after, inlineMedia, since, until, direction, orderBy, type, messageId);
        }
    }
}
