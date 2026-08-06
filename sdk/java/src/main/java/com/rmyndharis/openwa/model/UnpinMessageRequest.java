package com.rmyndharis.openwa.model;

/** Request body for removing a message's pin. */
public record UnpinMessageRequest(String chatId, String messageId) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        public UnpinMessageRequest build() {
            return new UnpinMessageRequest(chatId, messageId);
        }
    }
}
