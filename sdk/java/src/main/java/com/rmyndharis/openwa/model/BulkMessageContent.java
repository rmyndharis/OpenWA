package com.rmyndharis.openwa.model;

/** Content payload for one bulk-send item. Populate the field matching the item's {@link BulkMessageType}. */
public record BulkMessageContent(
    String text,
    SendMediaRequest image,
    SendMediaRequest video,
    SendMediaRequest audio,
    SendMediaRequest document,
    String caption) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String text;
        private SendMediaRequest image;
        private SendMediaRequest video;
        private SendMediaRequest audio;
        private SendMediaRequest document;
        private String caption;

        public Builder text(String v) {
            this.text = v;
            return this;
        }

        public Builder image(SendMediaRequest v) {
            this.image = v;
            return this;
        }

        public Builder video(SendMediaRequest v) {
            this.video = v;
            return this;
        }

        public Builder audio(SendMediaRequest v) {
            this.audio = v;
            return this;
        }

        public Builder document(SendMediaRequest v) {
            this.document = v;
            return this;
        }

        public Builder caption(String v) {
            this.caption = v;
            return this;
        }

        public BulkMessageContent build() {
            return new BulkMessageContent(text, image, video, audio, document, caption);
        }
    }
}
