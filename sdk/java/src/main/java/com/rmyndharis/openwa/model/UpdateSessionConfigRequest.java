package com.rmyndharis.openwa.model;

/**
 * Partial update of a RUNNING session's configuration — no re-link and no QR scan.
 *
 * <p>The route needs THREE states per field, not two: an absent key leaves the value unchanged, a key
 * sent as explicit null clears it back to the default, and a value sets it. A record of nullable
 * boxes can only express two, because Gson omits nulls by default — so the one operation this route
 * exists for, restoring {@code maxReconnectAttempts} to unlimited (which no in-range number can
 * express), was unreachable. The {@code clear*} flags carry the null case and
 * {@code UpdateSessionConfigRequestSerializer} is what emits it.
 *
 * <p>Build one with {@link #builder()}; a {@code clear} wins over a value for the same field.
 */
public record UpdateSessionConfigRequest(
        Boolean autoRejectCalls,
        Integer maxReconnectAttempts,
        Integer reconnectBaseDelay,
        boolean clearAutoRejectCalls,
        boolean clearMaxReconnectAttempts,
        boolean clearReconnectBaseDelay) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Boolean autoRejectCalls;
        private Integer maxReconnectAttempts;
        private Integer reconnectBaseDelay;
        private boolean clearAutoRejectCalls;
        private boolean clearMaxReconnectAttempts;
        private boolean clearReconnectBaseDelay;

        /** Auto-reject incoming calls. */
        public Builder autoRejectCalls(Boolean v) {
            this.autoRejectCalls = v;
            return this;
        }

        /** Cap consecutive reconnect attempts (0 disables reconnect entirely). */
        public Builder maxReconnectAttempts(Integer v) {
            this.maxReconnectAttempts = v;
            return this;
        }

        /** Base delay of the reconnect backoff, in milliseconds. */
        public Builder reconnectBaseDelay(Integer v) {
            this.reconnectBaseDelay = v;
            return this;
        }

        /** Send an explicit null for autoRejectCalls, restoring the server default. */
        public Builder clearAutoRejectCalls() {
            this.clearAutoRejectCalls = true;
            return this;
        }

        /** Send an explicit null, restoring UNLIMITED reconnect attempts. */
        public Builder clearMaxReconnectAttempts() {
            this.clearMaxReconnectAttempts = true;
            return this;
        }

        /** Send an explicit null for reconnectBaseDelay, restoring the server default. */
        public Builder clearReconnectBaseDelay() {
            this.clearReconnectBaseDelay = true;
            return this;
        }

        public UpdateSessionConfigRequest build() {
            return new UpdateSessionConfigRequest(
                    autoRejectCalls,
                    maxReconnectAttempts,
                    reconnectBaseDelay,
                    clearAutoRejectCalls,
                    clearMaxReconnectAttempts,
                    clearReconnectBaseDelay);
        }
    }
}
