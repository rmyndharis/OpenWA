package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * Request body for approving or rejecting group join requests.
 *
 * <p>A {@code null} participant list acts on every pending request.
 */
public record MembershipRequestActionRequest(List<String> participants) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private List<String> participants;

        /** Requester WhatsApp ids. Leave unset to act on every pending request. */
        public Builder participants(List<String> v) {
            this.participants = v;
            return this;
        }

        public MembershipRequestActionRequest build() {
            return new MembershipRequestActionRequest(participants);
        }
    }
}
