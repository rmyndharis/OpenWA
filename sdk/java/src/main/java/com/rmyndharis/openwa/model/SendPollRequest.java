package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for sending a native WhatsApp poll (2–12 options). */
public record SendPollRequest(String chatId, String name, List<String> options, Boolean allowMultipleAnswers) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String name;
        private List<String> options;
        private Boolean allowMultipleAnswers;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** Poll question / title (max 255 chars). */
        public Builder name(String v) {
            this.name = v;
            return this;
        }

        /** Options to vote on (WhatsApp allows between 2 and 12). */
        public Builder options(List<String> v) {
            this.options = v;
            return this;
        }

        /** Allow voters to pick several options (default single choice). */
        public Builder allowMultipleAnswers(Boolean v) {
            this.allowMultipleAnswers = v;
            return this;
        }

        public SendPollRequest build() {
            return new SendPollRequest(chatId, name, options, allowMultipleAnswers);
        }
    }
}
