package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for creating a new group. */
public record CreateGroupRequest(String name, List<String> participants) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;
        private List<String> participants;

        /** The group subject (name). */
        public Builder name(String v) {
            this.name = v;
            return this;
        }

        /** Initial member JIDs to add to the group. */
        public Builder participants(List<String> v) {
            this.participants = v;
            return this;
        }

        public CreateGroupRequest build() {
            return new CreateGroupRequest(name, participants);
        }
    }
}
