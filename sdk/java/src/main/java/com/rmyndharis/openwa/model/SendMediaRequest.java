package com.rmyndharis.openwa.model;

/** Request body for sending media (image/video/audio/document/sticker). Provide {@code url} or {@code base64}. */
public record SendMediaRequest(
    String chatId,
    String url,
    String base64,
    String mimetype,
    String filename,
    String caption,
    Boolean ptt) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String url;
        private String base64;
        private String mimetype;
        private String filename;
        private String caption;
        private Boolean ptt;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

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

        /** Required for documents; max 255 chars. */
        public Builder filename(String v) {
            this.filename = v;
            return this;
        }

        /** Max 1024 chars. */
        public Builder caption(String v) {
            this.caption = v;
            return this;
        }

        /** Audio only: send as a WhatsApp voice note (PTT). */
        public Builder ptt(Boolean v) {
            this.ptt = v;
            return this;
        }

        public SendMediaRequest build() {
            return new SendMediaRequest(chatId, url, base64, mimetype, filename, caption, ptt);
        }
    }
}
