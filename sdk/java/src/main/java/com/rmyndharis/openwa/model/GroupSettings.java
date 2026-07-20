package com.rmyndharis.openwa.model;

/**
 * Group settings — {@code announce} (only admins can send messages), {@code locked} (only admins
 * can edit group info) and {@code ephemeralSeconds} (disappearing-message timer). Every field is
 * optional: unset fields are omitted from the serialized body, so an update only touches the
 * settings that were set. Setting {@code ephemeralSeconds} returns HTTP 501 on the whatsapp-web.js
 * engine.
 */
public record GroupSettings(Boolean announce, Boolean locked, Integer ephemeralSeconds) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Boolean announce;
        private Boolean locked;
        private Integer ephemeralSeconds;

        /** Only admins can send messages. */
        public Builder announce(Boolean v) {
            this.announce = v;
            return this;
        }

        /** Only admins can edit group info. */
        public Builder locked(Boolean v) {
            this.locked = v;
            return this;
        }

        /** Disappearing-message timer in seconds ({@code 0} disables). Not supported on the whatsapp-web.js engine. */
        public Builder ephemeralSeconds(Integer v) {
            this.ephemeralSeconds = v;
            return this;
        }

        public GroupSettings build() {
            return new GroupSettings(announce, locked, ephemeralSeconds);
        }
    }
}
