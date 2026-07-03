package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for posting an image status. The server expects a nested {@code { image: {...} }} body. */
public record SendImageStatusRequest(StatusMediaInput image, List<String> recipients, String caption) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private StatusMediaInput image;
        private List<String> recipients;
        private String caption;

        /** Media payload: provide {@code url} OR {@code base64}. */
        public Builder image(StatusMediaInput v) {
            this.image = v;
            return this;
        }

        /** Recipient JIDs the status is addressed to (required by the server; empty → 400). */
        public Builder recipients(List<String> v) {
            this.recipients = v;
            return this;
        }

        public Builder caption(String v) {
            this.caption = v;
            return this;
        }

        public SendImageStatusRequest build() {
            return new SendImageStatusRequest(image, recipients, caption);
        }
    }
}
