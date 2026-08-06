package com.rmyndharis.openwa.model;

/** Request body for deleting a message. */
public record DeleteMessageRequest(String chatId, String messageId, Boolean forEveryone) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;
        private Boolean forEveryone;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        /** Delete for everyone (default true). */
        public Builder forEveryone(Boolean v) {
            this.forEveryone = v;
            return this;
        }

        public DeleteMessageRequest build() {
            return new DeleteMessageRequest(chatId, messageId, forEveryone);
        }
    }
}
