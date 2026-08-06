package com.rmyndharis.openwa.model;

/** Query parameters for {@code GET /sessions/:id/messages/:chatId/history}. Null fields are omitted. */
public record MessageHistoryQuery(Integer limit, Boolean includeMedia, Boolean deep) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Integer limit;
        private Boolean includeMedia;
        private Boolean deep;

        public Builder limit(Integer v) {
            this.limit = v;
            return this;
        }

        public Builder includeMedia(Boolean v) {
            this.includeMedia = v;
            return this;
        }

        public Builder deep(Boolean v) {
            this.deep = v;
            return this;
        }

        public MessageHistoryQuery build() {
            return new MessageHistoryQuery(limit, includeMedia, deep);
        }
    }
}
