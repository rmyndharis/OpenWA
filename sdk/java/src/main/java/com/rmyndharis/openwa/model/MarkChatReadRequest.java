package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for marking a chat read. */
public record MarkChatReadRequest(String chatId, List<String> messageIds) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private List<String> messageIds;

        /** WhatsApp chat id (JID), e.g. {@code 628123456789@c.us}. */
        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /**
         * Messages to acknowledge (at most 100; an empty list is refused). Baileys acknowledges
         * individual messages, so without this only the newest received message gets a receipt:
         * the one the engine holds in memory, else the newest received one the gateway stored.
         * Ignored by whatsapp-web.js, whose own sendSeen is chat-level.
         */
        public Builder messageIds(List<String> v) {
            this.messageIds = v;
            return this;
        }

        public MarkChatReadRequest build() {
            return new MarkChatReadRequest(chatId, messageIds);
        }
    }
}
