package com.rmyndharis.openwa.model;

/** Request body for replying to a specific message. */
public record ReplyMessageRequest(String chatId, String quotedMessageId, String text) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String quotedMessageId;
        private String text;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder quotedMessageId(String v) {
            this.quotedMessageId = v;
            return this;
        }

        public Builder text(String v) {
            this.text = v;
            return this;
        }

        public ReplyMessageRequest build() {
            return new ReplyMessageRequest(chatId, quotedMessageId, text);
        }
    }
}
