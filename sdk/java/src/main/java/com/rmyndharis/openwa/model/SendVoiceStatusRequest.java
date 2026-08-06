package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * Request body for posting an audio status as a voice note. The server expects a nested
 * {@code { audio: {...} }} body.
 *
 * <p>There is no caption: WhatsApp has nowhere to render one on a status voice note. The audio
 * mimetype defaults to {@code audio/ogg; codecs=opus}, the only format WhatsApp plays as one —
 * neither engine transcodes, so produce those bytes with {@code MediaResource.convertVoice}.
 */
public record SendVoiceStatusRequest(StatusMediaInput audio, List<String> recipients, String backgroundColor) {
    /**
     * Back-compat constructor for callers written before {@code backgroundColor} existed; leaves it
     * unset, which sends no colour.
     */
    public SendVoiceStatusRequest(StatusMediaInput audio, List<String> recipients) {
        this(audio, recipients, null);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private StatusMediaInput audio;
        private List<String> recipients;
        private String backgroundColor;

        /** Media payload: provide {@code url} OR {@code base64}. */
        public Builder audio(StatusMediaInput v) {
            this.audio = v;
            return this;
        }

        /** Required on the Baileys engine (absent/empty yields 400); omit on whatsapp-web.js. */
        public Builder recipients(List<String> v) {
            this.recipients = v;
            return this;
        }

        /** Background colour as {@code #RRGGBB}, behind the voice-note bubble. Baileys only. */
        public Builder backgroundColor(String v) {
            this.backgroundColor = v;
            return this;
        }

        public SendVoiceStatusRequest build() {
            return new SendVoiceStatusRequest(audio, recipients, backgroundColor);
        }
    }
}
