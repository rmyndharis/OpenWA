package com.rmyndharis.openwa.model;

/** Nested bulk media payload. The server consumes {@code ptt} only for the audio member. */
public record BulkMediaRequest(
    String url,
    String base64,
    String mimetype,
    String filename,
    Boolean ptt) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String url;
        private String base64;
        private String mimetype;
        private String filename;
        private Boolean ptt;

        public Builder url(String v) { this.url = v; return this; }
        public Builder base64(String v) { this.base64 = v; return this; }
        public Builder mimetype(String v) { this.mimetype = v; return this; }
        public Builder filename(String v) { this.filename = v; return this; }
        public Builder ptt(Boolean v) { this.ptt = v; return this; }

        public BulkMediaRequest build() {
            return new BulkMediaRequest(url, base64, mimetype, filename, ptt);
        }
    }
}
