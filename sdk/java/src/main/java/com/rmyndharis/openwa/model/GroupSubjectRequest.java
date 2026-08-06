package com.rmyndharis.openwa.model;

/** Request body for updating a group subject (name). */
public record GroupSubjectRequest(String subject) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String subject;

        /** The new group subject. */
        public Builder subject(String v) {
            this.subject = v;
            return this;
        }

        public GroupSubjectRequest build() {
            return new GroupSubjectRequest(subject);
        }
    }
}
