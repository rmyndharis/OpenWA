package com.rmyndharis.openwa.model;

/** Request body for setting the account's own global presence. */
public record SetOwnPresenceRequest(boolean available) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private boolean available;

        /** {@code true} to appear online; {@code false} to appear offline. */
        public Builder available(boolean v) {
            this.available = v;
            return this;
        }

        public SetOwnPresenceRequest build() {
            return new SetOwnPresenceRequest(available);
        }
    }
}
