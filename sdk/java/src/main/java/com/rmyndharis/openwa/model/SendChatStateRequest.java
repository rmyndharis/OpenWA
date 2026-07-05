package com.rmyndharis.openwa.model;

/** Request body for sending a chat presence state (typing/recording/paused). */
public record SendChatStateRequest(String chatId, ChatState state) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private ChatState state;

        /** WhatsApp chat id (JID), e.g. {@code 628123456789@c.us}. */
        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder state(ChatState v) {
            this.state = v;
            return this;
        }

        public SendChatStateRequest build() {
            return new SendChatStateRequest(chatId, state);
        }
    }
}
