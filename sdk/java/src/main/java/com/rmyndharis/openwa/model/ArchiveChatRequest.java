package com.rmyndharis.openwa.model;

/** Request body for archiving or unarchiving a chat. */
public record ArchiveChatRequest(String chatId, Boolean archive) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private Boolean archive;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** true to archive, false to unarchive. */
        public Builder archive(Boolean v) {
            this.archive = v;
            return this;
        }

        public ArchiveChatRequest build() {
            return new ArchiveChatRequest(chatId, archive);
        }
    }
}
