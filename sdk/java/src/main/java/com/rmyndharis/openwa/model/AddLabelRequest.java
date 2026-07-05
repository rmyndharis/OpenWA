package com.rmyndharis.openwa.model;

/** Request body for adding a label to a chat. Requires an OPERATOR-level key. */
public record AddLabelRequest(String labelId) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String labelId;

        /** Id of the label to apply to the chat. */
        public Builder labelId(String v) {
            this.labelId = v;
            return this;
        }

        public AddLabelRequest build() {
            return new AddLabelRequest(labelId);
        }
    }
}
