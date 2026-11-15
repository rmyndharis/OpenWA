package com.rmyndharis.openwa.model;

/**
 * Partial update of a session's configuration — no re-link and no QR scan. {@code autoRejectCalls}
 * and {@code linkPreview} apply immediately; {@code maxReconnectAttempts} and
 * {@code reconnectBaseDelay} apply on the next start.
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
        Boolean linkPreview,
        boolean clearAutoRejectCalls,
        boolean clearMaxReconnectAttempts,
        boolean clearReconnectBaseDelay,
        boolean clearLinkPreview) {

    /** Back-compatible constructor without {@code linkPreview} or {@code clearLinkPreview}. */
    public UpdateSessionConfigRequest(
            Boolean autoRejectCalls,
            Integer maxReconnectAttempts,
            Integer reconnectBaseDelay,
            boolean clearAutoRejectCalls,
            boolean clearMaxReconnectAttempts,
            boolean clearReconnectBaseDelay) {
        this(
                autoRejectCalls,
                maxReconnectAttempts,
                reconnectBaseDelay,
                null,
                clearAutoRejectCalls,
                clearMaxReconnectAttempts,
                clearReconnectBaseDelay,
                false);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Boolean autoRejectCalls;
        private Integer maxReconnectAttempts;
        private Integer reconnectBaseDelay;
        private Boolean linkPreview;
        private boolean clearAutoRejectCalls;
        private boolean clearMaxReconnectAttempts;
        private boolean clearReconnectBaseDelay;
        private boolean clearLinkPreview;

        /**
         * Auto-reject incoming calls. Baileys only: whatsapp-web.js stores the flag but cannot reject a
         * call, so calls keep ringing there.
         */
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

        /**
         * Link preview for a send-text or send-template that sets neither {@code linkPreview} nor
         * {@code customLinkPreview}.
         */
        public Builder linkPreview(Boolean v) {
            this.linkPreview = v;
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

        /** Send an explicit null for linkPreview, restoring the engine's own default. */
        public Builder clearLinkPreview() {
            this.clearLinkPreview = true;
            return this;
        }

        public UpdateSessionConfigRequest build() {
            return new UpdateSessionConfigRequest(
                    autoRejectCalls,
                    maxReconnectAttempts,
                    reconnectBaseDelay,
                    linkPreview,
                    clearAutoRejectCalls,
                    clearMaxReconnectAttempts,
                    clearReconnectBaseDelay,
                    clearLinkPreview);
        }
    }
}
