package com.rmyndharis.openwa.model;

/** Request body for creating a template. Optional fields are omitted from the payload when {@code null}. */
public record CreateTemplateRequest(String name, String body, String header, String footer) {
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

        public CreateTemplateRequest build() {
            return new CreateTemplateRequest(name, body, header, footer);
        }
    }
}
