package com.rmyndharis.openwa.model;

/** Request body for starring or unstarring a message. */
public record StarMessageRequest(String chatId, String messageId, Boolean star) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;
        private Boolean star;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        /** true to star, false to remove the star. */
        public Builder star(Boolean v) {
            this.star = v;
            return this;
        }

        public StarMessageRequest build() {
            return new StarMessageRequest(chatId, messageId, star);
        }
    }
}
