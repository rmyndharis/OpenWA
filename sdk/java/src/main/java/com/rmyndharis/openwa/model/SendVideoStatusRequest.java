package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for posting a video status. The server expects a nested {@code { video: {...} }} body. */
public record SendVideoStatusRequest(StatusMediaInput video, List<String> recipients, String caption) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private StatusMediaInput video;
        private List<String> recipients;
        private String caption;

        /** Media payload: provide {@code url} OR {@code base64}. */
        public Builder video(StatusMediaInput v) {
            this.video = v;
            return this;
        }

        /** Recipient JIDs. Required on the Baileys engine (absent/empty → 400); omit on whatsapp-web.js, which broadcasts instead. */
        public Builder recipients(List<String> v) {
            this.recipients = v;
            return this;
        }

        public Builder caption(String v) {
            this.caption = v;
            return this;
        }

        public SendVideoStatusRequest build() {
            return new SendVideoStatusRequest(video, recipients, caption);
        }
    }
}
