package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for sending a text message. */
public record SendTextRequest(String chatId, String text, List<String> mentions) {
    /** Back-compatible constructor without mentions. */
    public SendTextRequest(String chatId, String text) {
        this(chatId, text, null);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String text;
        private List<String> mentions;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** Max 4096 chars. */
        public Builder text(String v) {
            this.text = v;
            return this;
        }

        /** WIDs to @mention (e.g. {@code ["62811@c.us"]}). The text must also contain the {@code @<number>} token. */
        public Builder mentions(List<String> v) {
            this.mentions = v;
            return this;
        }

        public SendTextRequest build() {
            return new SendTextRequest(chatId, text, mentions);
        }
    }
}
