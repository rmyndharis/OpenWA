package com.rmyndharis.openwa.model;

/** Request body for forwarding a message to another chat. */
public record ForwardMessageRequest(String fromChatId, String toChatId, String messageId) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String fromChatId;
        private String toChatId;
        private String messageId;

        public Builder fromChatId(String v) {
            this.fromChatId = v;
            return this;
        }

        public Builder toChatId(String v) {
            this.toChatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        public ForwardMessageRequest build() {
            return new ForwardMessageRequest(fromChatId, toChatId, messageId);
        }
    }
}
