package com.rmyndharis.openwa.model;

import java.util.List;
import java.util.Map;

/** Request body for updating a webhook. Every field is optional; omit to leave unchanged. */
public record UpdateWebhookRequest(
    String url,
    List<WebhookEvent> events,
    String secret,
    Map<String, String> headers,
    WebhookFilters filters,
    Integer retryCount,
    Boolean active) {

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String url;
        private List<WebhookEvent> events;
        private String secret;
        private Map<String, String> headers;
        private WebhookFilters filters;
        private Integer retryCount;
        private Boolean active;

        /** Destination URL that receives the event payload. */
        public Builder url(String v) {
            this.url = v;
            return this;
        }

        /** Events to subscribe to. Use {@link WebhookEvent#ALL} to receive all. */
        public Builder events(List<WebhookEvent> v) {
            this.events = v;
            return this;
        }

        /** HMAC secret; signed as {@code X-OpenWA-Signature: sha256=…}. */
        public Builder secret(String v) {
            this.secret = v;
            return this;
        }

        public Builder headers(Map<String, String> v) {
            this.headers = v;
            return this;
        }

        public Builder filters(WebhookFilters v) {
            this.filters = v;
            return this;
        }

        /** 0–5; default 3. Server DTO field is {@code retryCount}. */
        public Builder retryCount(Integer v) {
            this.retryCount = v;
            return this;
        }

        /** Enable or disable delivery without deleting the webhook. */
        public Builder active(Boolean v) {
            this.active = v;
            return this;
        }

        public UpdateWebhookRequest build() {
            return new UpdateWebhookRequest(url, events, secret, headers, filters, retryCount, active);
        }
    }
}
