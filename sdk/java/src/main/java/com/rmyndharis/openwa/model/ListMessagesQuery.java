package com.rmyndharis.openwa.model;

/** Query parameters for {@code GET /sessions/:id/messages}. Null fields are omitted. */
public record ListMessagesQuery(String chatId, String from, Integer limit, Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String from;
        private Integer limit;
        private Integer offset;

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

        public ListMessagesQuery build() {
            return new ListMessagesQuery(chatId, from, limit, offset);
        }
    }
}
