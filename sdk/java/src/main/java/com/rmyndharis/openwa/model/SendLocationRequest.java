package com.rmyndharis.openwa.model;

/** Request body for sending a location. */
public record SendLocationRequest(
    String chatId,
    double latitude,
    double longitude,
    String description,
    String address,
    String quotedMessageId) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        // Boxed so build() can tell a coordinate never set from 0.0, which is a real place.
        private Double latitude;
        private Double longitude;
        private String description;
        private String address;
        private String quotedMessageId;

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

        /**
         * Quote an earlier message, turning this send into a reply. Engine-specific:
         * whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message
         * it has already stored.
         */
        public Builder quotedMessageId(String v) {
            this.quotedMessageId = v;
            return this;
        }

        /**
         * @throws IllegalArgumentException when latitude or longitude was never set: the request would carry 0.0
         *     and the gateway would send a pin at that point.
         */
        public SendLocationRequest build() {
            if (latitude == null || longitude == null) {
                throw new IllegalArgumentException("OpenWA: a location needs both latitude and longitude");
            }
            return new SendLocationRequest(chatId, latitude, longitude, description, address, quotedMessageId);
        }
    }
}
