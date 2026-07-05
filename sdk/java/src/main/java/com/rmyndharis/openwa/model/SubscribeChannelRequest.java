package com.rmyndharis.openwa.model;

/** Request body for subscribing to a channel by its invite code. */
public record SubscribeChannelRequest(String inviteCode) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String inviteCode;

        /** Channel invite code (from a channel link). */
        public Builder inviteCode(String v) {
            this.inviteCode = v;
            return this;
        }

        public SubscribeChannelRequest build() {
            return new SubscribeChannelRequest(inviteCode);
        }
    }
}
