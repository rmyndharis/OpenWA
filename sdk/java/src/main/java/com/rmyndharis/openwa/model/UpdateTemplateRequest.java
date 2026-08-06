package com.rmyndharis.openwa.model;

/** Request body for updating a template. Every field is optional; {@code null} fields are omitted from the payload. */
public record UpdateTemplateRequest(String name, String body, String header, String footer) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String name;
        private String body;
        private String header;
        private String footer;

        /** Unique template name within the session. */
        public Builder name(String v) {
            this.name = v;
            return this;
        }

        /** Template body with {@code {{variable}}} placeholders. */
        public Builder body(String v) {
            this.body = v;
            return this;
        }

        public Builder header(String v) {
            this.header = v;
            return this;
        }

        public Builder footer(String v) {
            this.footer = v;
            return this;
        }

        public UpdateTemplateRequest build() {
            return new UpdateTemplateRequest(name, body, header, footer);
        }
    }
}
