package com.rmyndharis.openwa.model;

import java.util.Map;

/** Request body for rendering and sending a stored message template. */
public record SendTemplateRequest(String chatId, String templateId, String templateName, Map<String, String> vars) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String templateId;
        private String templateName;
        private Map<String, String> vars;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** Provide exactly one of {@code templateId} or {@code templateName}. */
        public Builder templateId(String v) {
            this.templateId = v;
            return this;
        }

        /** Provide exactly one of {@code templateId} or {@code templateName}. */
        public Builder templateName(String v) {
            this.templateName = v;
            return this;
        }

        /** Template variables (server DTO field is {@code vars}). */
        public Builder vars(Map<String, String> v) {
            this.vars = v;
            return this;
        }

        public SendTemplateRequest build() {
            return new SendTemplateRequest(chatId, templateId, templateName, vars);
        }
    }
}
