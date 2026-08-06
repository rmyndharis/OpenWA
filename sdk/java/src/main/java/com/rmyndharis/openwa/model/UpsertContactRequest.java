package com.rmyndharis.openwa.model;

/** Request body for saving or editing an addressbook contact. */
public record UpsertContactRequest(String firstName, String lastName) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String firstName;
        private String lastName;

        public Builder firstName(String v) {
            this.firstName = v;
            return this;
        }

        /** Omit for a single-name contact. */
        public Builder lastName(String v) {
            this.lastName = v;
            return this;
        }

        public UpsertContactRequest build() {
            return new UpsertContactRequest(firstName, lastName);
        }
    }
}
