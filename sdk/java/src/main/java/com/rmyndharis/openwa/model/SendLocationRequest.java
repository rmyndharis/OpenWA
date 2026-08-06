package com.rmyndharis.openwa.model;

/** Request body for sending a location. */
public record SendLocationRequest(
    String chatId,
    double latitude,
    double longitude,
    String description,
    String address) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private double latitude;
        private double longitude;
        private String description;
        private String address;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        public Builder latitude(double v) {
            this.latitude = v;
            return this;
        }

        public Builder longitude(double v) {
            this.longitude = v;
            return this;
        }

        public Builder description(String v) {
            this.description = v;
            return this;
        }

        public Builder address(String v) {
            this.address = v;
            return this;
        }

        public SendLocationRequest build() {
            return new SendLocationRequest(chatId, latitude, longitude, description, address);
        }
    }
}
