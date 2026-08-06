package com.rmyndharis.openwa.model;

/** Request body for editing the text of a message sent by this account. */
public record EditMessageRequest(String chatId, String messageId, String body) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;
        private String body;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        /** The replacement message text. */
        public Builder body(String v) {
            this.body = v;
            return this;
        }

        public EditMessageRequest build() {
            return new EditMessageRequest(chatId, messageId, body);
        }
    }
}
