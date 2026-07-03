package com.rmyndharis.openwa.model;

/** Request body for sending a text message. */
public record SendTextRequest(String chatId, String text) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String text;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** Max 4096 chars. */
        public Builder text(String v) {
            this.text = v;
            return this;
        }

        public SendTextRequest build() {
            return new SendTextRequest(chatId, text);
        }
    }
}
