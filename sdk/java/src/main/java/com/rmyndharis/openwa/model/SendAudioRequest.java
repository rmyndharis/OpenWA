package com.rmyndharis.openwa.model;

/** Request body for sending audio, including the audio-only voice-note (PTT) flag. */
public record SendAudioRequest(
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

        public Builder chatId(String v) { this.chatId = v; return this; }
        public Builder url(String v) { this.url = v; return this; }
        public Builder base64(String v) { this.base64 = v; return this; }
        public Builder mimetype(String v) { this.mimetype = v; return this; }
        public Builder filename(String v) { this.filename = v; return this; }
        public Builder caption(String v) { this.caption = v; return this; }
        public Builder ptt(Boolean v) { this.ptt = v; return this; }

        public SendAudioRequest build() {
            return new SendAudioRequest(chatId, url, base64, mimetype, filename, caption, ptt);
        }
    }
}
