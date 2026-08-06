package com.rmyndharis.openwa.model;

/** Query parameters for listing chats. Null fields are omitted from the URL. */
public record ListChatsQuery(Integer limit, Integer offset) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;
        private Integer offset;

        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public Builder offset(Integer v) {
            this.offset = v;
            return this;
        }

        public ListChatsQuery build() {
            return new ListChatsQuery(limit, offset);
        }
    }
}
