package com.rmyndharis.openwa.model;

/** Request body for sending a product message. Requires an OPERATOR-level key. */
public record SendProductRequest(String chatId, String productId, String body) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String productId;
        private String body;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder productId(String v) {
            this.productId = v;
            return this;
        }

        /** Optional body/caption text. */
        public Builder body(String v) {
            this.body = v;
            return this;
        }

        public SendProductRequest build() {
            return new SendProductRequest(chatId, productId, body);
        }
    }
}
