package com.rmyndharis.openwa.model;

/**
 * Request body for creating a shareable WhatsApp call link.
 *
 * @param type {@code "audio"} or {@code "video"}; WhatsApp's own URL path for audio is {@code /voice/}
 * @param startTime absolute epoch MILLISECONDS the call is scheduled to start at
 */
public record CreateCallLinkRequest(String type, Double startTime) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String type;
        private Double startTime;

        /** {@code "audio"} or {@code "video"}. */
        public Builder type(String v) {
            this.type = v;
            return this;
        }

        /** Absolute epoch MILLISECONDS. A link for right now is the current timestamp. */
        public Builder startTime(Double v) {
            this.startTime = v;
            return this;
        }

        public CreateCallLinkRequest build() {
            return new CreateCallLinkRequest(type, startTime);
        }
    }
}
