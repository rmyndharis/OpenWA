package com.rmyndharis.openwa.model;

/** Request body for sending a catalog link message. Requires an OPERATOR-level key. */
public record SendCatalogRequest(String chatId, String body) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String body;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** Optional body/caption text. */
        public Builder body(String v) {
            this.body = v;
            return this;
        }

        public SendCatalogRequest build() {
            return new SendCatalogRequest(chatId, body);
        }
    }
}
