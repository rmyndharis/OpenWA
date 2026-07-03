package com.rmyndharis.openwa.model;

import java.util.Map;

/** One entry in a bulk-send request. */
public record BulkMessageItem(
    String chatId,
    BulkMessageType type,
    BulkMessageContent content,
    Map<String, String> variables) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private BulkMessageType type;
        private BulkMessageContent content;
        private Map<String, String> variables;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder type(BulkMessageType v) {
            this.type = v;
            return this;
        }

        public Builder content(BulkMessageContent v) {
            this.content = v;
            return this;
        }

        public Builder variables(Map<String, String> v) {
            this.variables = v;
            return this;
        }

        public BulkMessageItem build() {
            return new BulkMessageItem(chatId, type, content, variables);
        }
    }
}
