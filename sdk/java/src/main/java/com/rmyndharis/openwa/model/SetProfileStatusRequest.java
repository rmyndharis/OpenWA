package com.rmyndharis.openwa.model;

/** Request body for setting the account about/status text (an empty string clears it). */
public record SetProfileStatusRequest(String status) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String status;

        /** The new status text; empty string clears it. */
        public Builder status(String v) {
            this.status = v;
            return this;
        }

        public SetProfileStatusRequest build() {
            return new SetProfileStatusRequest(status);
        }
    }
}
