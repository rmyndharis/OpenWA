package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for an asynchronous batch send ({@code POST /messages/send-bulk}). */
public record SendBulkRequest(List<BulkMessageItem> messages, String batchId, Options options) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private List<BulkMessageItem> messages;
        private String batchId;
        private Options options;

        public Builder messages(List<BulkMessageItem> v) {
            this.messages = v;
            return this;
        }

        /** Optional caller-supplied idempotency/batch id. */
        public Builder batchId(String v) {
            this.batchId = v;
            return this;
        }

        public Builder options(Options v) {
            this.options = v;
            return this;
        }

        public SendBulkRequest build() {
            return new SendBulkRequest(messages, batchId, options);
        }
    }

    /** Pacing options for a bulk send. Null fields are omitted. */
    public record Options(Integer delayBetweenMessages, Boolean randomizeDelay, Boolean stopOnError) {
        public static Builder builder() {
            return new Builder();
        }

        public static final class Builder {
            private Integer delayBetweenMessages;
            private Boolean randomizeDelay;
            private Boolean stopOnError;

            /** Minimum 1000 ms; default 3000. */
            public Builder delayBetweenMessages(Integer v) {
                this.delayBetweenMessages = v;
                return this;
            }

            /** Randomize the delay between messages to look less automated. */
            public Builder randomizeDelay(Boolean v) {
                this.randomizeDelay = v;
                return this;
            }

            public Builder stopOnError(Boolean v) {
                this.stopOnError = v;
                return this;
            }

            public Options build() {
                return new Options(delayBetweenMessages, randomizeDelay, stopOnError);
            }
        }
    }
}
