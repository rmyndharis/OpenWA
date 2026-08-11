package com.rmyndharis.openwa.model;

/**
 * Request body for demoting a channel admin back to a subscriber.
 *
 * @param userId WhatsApp ID of the admin to demote
 */
public record DemoteChannelAdminRequest(String userId) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String userId;

        /** WhatsApp ID of the admin to demote back to a subscriber. */
        public Builder userId(String v) {
            this.userId = v;
            return this;
        }

        public DemoteChannelAdminRequest build() {
            return new DemoteChannelAdminRequest(userId);
        }
    }
}
