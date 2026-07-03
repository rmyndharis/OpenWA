package com.rmyndharis.openwa.model;

import java.util.List;
import java.util.Map;

/** Request body for creating a webhook. Optional fields are omitted when {@code null}. */
public record CreateWebhookRequest(
    String url,
    List<WebhookEvent> events,
    String secret,
    Map<String, String> headers,
    WebhookFilters filters,
    Integer retryCount) {

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

        public CreateWebhookRequest build() {
            return new CreateWebhookRequest(url, events, secret, headers, filters, retryCount);
        }
    }
}
