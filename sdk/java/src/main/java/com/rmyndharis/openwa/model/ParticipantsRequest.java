package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body carrying a list of participant JIDs. */
public record ParticipantsRequest(List<String> participants) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private List<String> participants;

        /** Participant JIDs to act on. */
        public Builder participants(List<String> v) {
            this.participants = v;
            return this;
        }

        public ParticipantsRequest build() {
            return new ParticipantsRequest(participants);
        }
    }
}
