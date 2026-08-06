package com.rmyndharis.openwa.model;

/** Request body for updating a group description. */
public record GroupDescriptionRequest(String description) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String description;

        /** The new group description. May be empty to clear it. */
        public Builder description(String v) {
            this.description = v;
            return this;
        }

        public GroupDescriptionRequest build() {
            return new GroupDescriptionRequest(description);
        }
    }
}
