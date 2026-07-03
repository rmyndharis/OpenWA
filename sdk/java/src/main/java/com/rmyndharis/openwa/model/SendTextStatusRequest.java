package com.rmyndharis.openwa.model;

import java.util.List;

/** Request body for posting a text status. Optional fields are omitted from the payload when {@code null}. */
public record SendTextStatusRequest(String text, List<String> recipients, String backgroundColor, Integer font) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String text;
        private List<String> recipients;
        private String backgroundColor;
        private Integer font;

        /** The status text. */
        public Builder text(String v) {
            this.text = v;
            return this;
        }

        /** Recipient JIDs the status is addressed to (required by the server; empty → 400). */
        public Builder recipients(List<String> v) {
            this.recipients = v;
            return this;
        }

        /** Hex background color, e.g. {@code #25D366}. */
        public Builder backgroundColor(String v) {
            this.backgroundColor = v;
            return this;
        }

        /** Font index supported by WhatsApp status. */
        public Builder font(Integer v) {
            this.font = v;
            return this;
        }

        public SendTextStatusRequest build() {
            return new SendTextStatusRequest(text, recipients, backgroundColor, font);
        }
    }
}
