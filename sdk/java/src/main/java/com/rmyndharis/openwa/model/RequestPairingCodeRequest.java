package com.rmyndharis.openwa.model;

/** Request body for {@code requestPairingCode}. */
public record RequestPairingCodeRequest(String phoneNumber) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String phoneNumber;

        /** Digits only, international format, e.g. {@code 628123456789}. */
        public Builder phoneNumber(String v) {
            this.phoneNumber = v;
            return this;
        }

        public RequestPairingCodeRequest build() {
            return new RequestPairingCodeRequest(phoneNumber);
        }
    }
}
