package com.rmyndharis.openwa.model;

/** Content payload for one bulk-send item. Populate the field matching the item's {@link BulkMessageType}. */
public record BulkMessageContent(
    String text,
    BulkMediaRequest image,
    BulkMediaRequest video,
    BulkMediaRequest audio,
    BulkMediaRequest document,
    String caption) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String text;
        private BulkMediaRequest image;
        private BulkMediaRequest video;
        private BulkMediaRequest audio;
        private BulkMediaRequest document;
        private String caption;

        public Builder text(String v) {
            this.text = v;
            return this;
        }

        public Builder image(BulkMediaRequest v) {
            this.image = v;
            return this;
        }

        public Builder video(BulkMediaRequest v) {
            this.video = v;
            return this;
        }

        public Builder audio(BulkMediaRequest v) {
            this.audio = v;
            return this;
        }

        public Builder document(BulkMediaRequest v) {
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
