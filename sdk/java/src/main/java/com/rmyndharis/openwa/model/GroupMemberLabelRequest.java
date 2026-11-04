package com.rmyndharis.openwa.model;

/** Request body for setting this account's member label in a group. */
public record GroupMemberLabelRequest(String label) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String label;

        /** The label, at most 30 UTF-16 code units. May be empty to clear it. */
        public Builder label(String v) {
            this.label = v;
            return this;
        }

        public GroupMemberLabelRequest build() {
            return new GroupMemberLabelRequest(label);
        }
    }
}
