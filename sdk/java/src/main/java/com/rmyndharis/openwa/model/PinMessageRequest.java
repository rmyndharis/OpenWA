package com.rmyndharis.openwa.model;

/** Request body for pinning a message in its chat. */
public record PinMessageRequest(String chatId, String messageId, Integer durationSeconds) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;
        private Integer durationSeconds;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        /** 86400 (24h), 604800 (7d) or 2592000 (30d). Defaults to 24h when omitted. */
        public Builder durationSeconds(Integer v) {
            this.durationSeconds = v;
            return this;
        }

        public PinMessageRequest build() {
            return new PinMessageRequest(chatId, messageId, durationSeconds);
        }
    }
}
