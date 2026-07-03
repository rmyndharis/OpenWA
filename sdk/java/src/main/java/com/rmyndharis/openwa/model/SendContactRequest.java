package com.rmyndharis.openwa.model;

/** Request body for sending a contact card. */
public record SendContactRequest(String chatId, String contactName, String contactNumber) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String contactName;
        private String contactNumber;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder contactName(String v) {
            this.contactName = v;
            return this;
        }

        public Builder contactNumber(String v) {
            this.contactNumber = v;
            return this;
        }

        public SendContactRequest build() {
            return new SendContactRequest(chatId, contactName, contactNumber);
        }
    }
}
