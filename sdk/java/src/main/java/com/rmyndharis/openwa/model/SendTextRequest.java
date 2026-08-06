package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for sending a text message. */
public record SendTextRequest(
    String chatId, String text, List<String> mentions, Boolean linkPreview, CustomLinkPreview customLinkPreview) {
    /** Back-compatible constructor without mentions. */
    public SendTextRequest(String chatId, String text) {
        this(chatId, text, null, null, null);
    }

    /** Back-compatible constructor without a link-preview choice. */
    public SendTextRequest(String chatId, String text, List<String> mentions) {
        this(chatId, text, mentions, null, null);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String chatId;
        private String text;
        private List<String> mentions;
        private Boolean linkPreview;
        private CustomLinkPreview customLinkPreview;

        public Builder chatId(String v) {
            this.chatId = v;
            return this;
        }

        /** Max 4096 chars. */
        public Builder text(String v) {
            this.text = v;
            return this;
        }

        /** WIDs to @mention (e.g. {@code ["62811@c.us"]}). The text must also contain the {@code @<number>} token. */
        public Builder mentions(List<String> v) {
            this.mentions = v;
            return this;
        }

        /**
         * {@code false} suppresses the URL preview. Guaranteed only in that direction: unset means the
         * engine default, and the engines differ — whatsapp-web.js asks WhatsApp Web to build a
         * preview by default; on Baileys a preview is OPT-IN and needs {@code true}.
         */
        public Builder linkPreview(Boolean v) {
            this.linkPreview = v;
            return this;
        }

        /**
         * Attach a preview you supply instead of one fetched from the URL. Baileys only; cannot be
         * combined with {@code linkPreview(false)}.
         */
        public Builder customLinkPreview(CustomLinkPreview v) {
            this.customLinkPreview = v;
            return this;
        }

        public SendTextRequest build() {
            return new SendTextRequest(chatId, text, mentions, linkPreview, customLinkPreview);
        }
    }
}
