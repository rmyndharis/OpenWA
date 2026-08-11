package com.rmyndharis.openwa.model;

/**
 * Request body for muting a chat until an absolute timestamp, or unmuting it.
 *
 * <p>This body is serialized by the client's null-emitting Gson. A null {@code muteUntil} is the
 * unmute signal and has to reach the wire as an explicit null — Gson's default behaviour would drop
 * the key entirely, which the route rejects rather than reading as an unmute.
 */
public record MuteChatRequest(String chatId, Long muteUntil) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private Long muteUntil;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /**
         * Absolute epoch MILLISECONDS at which the mute expires, or null to unmute now.
         *
         * <p>Milliseconds, not seconds: a seconds-scale value is an instant in 1970, so the mute
         * expires the moment it is set while the request still answers 200, and nothing in the
         * response says otherwise.
         */
        public Builder muteUntil(Long v) {
            this.muteUntil = v;
            return this;
        }

        public MuteChatRequest build() {
            return new MuteChatRequest(chatId, muteUntil);
        }
    }
}
