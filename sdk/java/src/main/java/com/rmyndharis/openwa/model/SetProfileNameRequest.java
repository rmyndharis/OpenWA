package com.rmyndharis.openwa.model;

/** Request body for setting the account display name. */
public record SetProfileNameRequest(String name) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;

        /** The new display name. */
        public Builder name(String v) {
            this.name = v;
            return this;
        }

        public SetProfileNameRequest build() {
            return new SetProfileNameRequest(name);
        }
    }
}
