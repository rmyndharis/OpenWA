package com.rmyndharis.openwa.model;

/** Request body for joining a group via an invite code. */
public record JoinGroupRequest(String inviteCode) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String inviteCode;

        /** The invite code (from an invite link such as {@code https://chat.whatsapp.com/<code>}). */
        public Builder inviteCode(String v) {
            this.inviteCode = v;
            return this;
        }

        public JoinGroupRequest build() {
            return new JoinGroupRequest(inviteCode);
        }
    }
}
