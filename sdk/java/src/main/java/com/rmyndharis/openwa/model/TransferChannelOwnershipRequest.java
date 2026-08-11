package com.rmyndharis.openwa.model;

/**
 * Request body for handing a channel to a new owner.
 *
 * <p>The transfer is irreversible: once it lands, this session can no longer take the channel back.
 *
 * @param newOwnerId WhatsApp ID of the account that becomes the new owner
 */
public record TransferChannelOwnershipRequest(String newOwnerId) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String newOwnerId;

        /** WhatsApp ID of the account that becomes the new owner. */
        public Builder newOwnerId(String v) {
            this.newOwnerId = v;
            return this;
        }

        public TransferChannelOwnershipRequest build() {
            return new TransferChannelOwnershipRequest(newOwnerId);
        }
    }
}
