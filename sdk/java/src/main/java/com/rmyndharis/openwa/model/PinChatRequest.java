package com.rmyndharis.openwa.model;

/** Request body for pinning a chat to the top of the list, or unpinning it. */
public record PinChatRequest(String chatId, Boolean pin) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private Boolean pin;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** true to pin the chat to the top of the list, false to unpin it. */
        public Builder pin(Boolean v) {
            this.pin = v;
            return this;
        }

        public PinChatRequest build() {
            return new PinChatRequest(chatId, pin);
        }
    }
}
