package com.rmyndharis.openwa.model;

/** Request body for reacting to a message (an empty {@code emoji} removes the reaction). */
public record ReactMessageRequest(String chatId, String messageId, String emoji) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;
        private String emoji;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        /** Empty string removes the reaction. */
        public Builder emoji(String v) {
            this.emoji = v;
            return this;
        }

        public ReactMessageRequest build() {
            return new ReactMessageRequest(chatId, messageId, emoji);
        }
    }
}
