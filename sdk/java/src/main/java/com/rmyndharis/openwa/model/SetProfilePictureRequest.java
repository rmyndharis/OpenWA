package com.rmyndharis.openwa.model;

/** Request body for setting the account profile picture. Provide {@code url} or {@code base64}. */
public record SetProfilePictureRequest(String url, String base64, String mimetype) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String url;
        private String base64;
        private String mimetype;

        /** Mutually exclusive with {@code base64}. */
        public Builder url(String v) {
            this.url = v;
            return this;
        }

        /** Requires {@code mimetype}. */
        public Builder base64(String v) {
            this.base64 = v;
            return this;
        }

        public Builder mimetype(String v) {
            this.mimetype = v;
            return this;
        }

        public SetProfilePictureRequest build() {
            return new SetProfilePictureRequest(url, base64, mimetype);
        }
    }
}
