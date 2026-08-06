package com.rmyndharis.openwa.model;

/**
 * Request body for setting a group's picture. Provide exactly one of {@code url} or
 * {@code base64} (base64 wins when both are present); {@code mimetype} is required with base64.
 */
public record SetGroupPictureRequest(String url, String base64, String mimetype) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String url;
        private String base64;
        private String mimetype;

        public Builder url(String v) {
            this.url = v;
            return this;
        }

        public Builder base64(String v) {
            this.base64 = v;
            return this;
        }

        public Builder mimetype(String v) {
            this.mimetype = v;
            return this;
        }

        public SetGroupPictureRequest build() {
            return new SetGroupPictureRequest(url, base64, mimetype);
        }
    }
}
