package com.rmyndharis.openwa.model;

/**
 * Request body for tapping a choice on a WhatsApp Business prompt. Baileys only:
 * whatsapp-web.js answers 501.
 */
public record ClickButtonRequest(String chatId, String messageId, String buttonId, String text) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String messageId;
        private String buttonId;
        private String text;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder messageId(String v) {
            this.messageId = v;
            return this;
        }

        public Builder buttonId(String v) {
            this.buttonId = v;
            return this;
        }

        public Builder text(String v) {
            this.text = v;
            return this;
        }

        public ClickButtonRequest build() {
            return new ClickButtonRequest(chatId, messageId, buttonId, text);
        }
    }
}
