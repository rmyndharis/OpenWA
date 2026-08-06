package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * Request body for voting on a poll. {@code options} are the option TEXTS as they appear on the
 * poll — no engine surfaces stable per-option ids. The list replaces the current selection; an
 * empty list clears the vote.
 */
public record VotePollRequest(String chatId, String pollMessageId, List<String> options) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String pollMessageId;
        private List<String> options;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder pollMessageId(String v) {
            this.pollMessageId = v;
            return this;
        }

        public Builder options(List<String> v) {
            this.options = v;
            return this;
        }

        public VotePollRequest build() {
            return new VotePollRequest(chatId, pollMessageId, options);
        }
    }
}
