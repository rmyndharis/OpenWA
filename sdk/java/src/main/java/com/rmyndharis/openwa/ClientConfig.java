package com.rmyndharis.openwa;

import com.rmyndharis.openwa.http.HttpTransport;
import java.time.Duration;
import java.util.Map;

/** Immutable client configuration. Build via {@link #builder()}. */
public final class ClientConfig {
    final String baseUrl;
    final String apiKey;
    final Duration timeout;
    final Map<String, String> defaultHeaders;
    final HttpTransport transport; // nullable → OpenWAClient supplies DefaultHttpTransport

    private ClientConfig(Builder b) {
        this.baseUrl = b.baseUrl;
        this.apiKey = b.apiKey;
        this.timeout = b.timeout != null ? b.timeout : Duration.ofSeconds(30);
        this.defaultHeaders = b.defaultHeaders != null ? b.defaultHeaders : Map.of();
        this.transport = b.transport;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String baseUrl;
        private String apiKey;
        private Duration timeout;
        private Map<String, String> defaultHeaders;
        private HttpTransport transport;

        /** Base URL of the OpenWA API, e.g. {@code http://localhost:2785}. */
        public Builder baseUrl(String v) {
            this.baseUrl = v;
            return this;
        }

        /** API key sent as {@code X-API-Key}. */
        public Builder apiKey(String v) {
            this.apiKey = v;
            return this;
        }

        /** Per-request timeout (default 30s). */
        public Builder timeout(Duration v) {
            this.timeout = v;
            return this;
        }

        /** Default headers applied to every request (auth + JSON content-type always win). */
        public Builder defaultHeaders(Map<String, String> v) {
            this.defaultHeaders = v;
            return this;
        }

        /** Injectable transport; defaults to {@link com.rmyndharis.openwa.http.DefaultHttpTransport}. */
        public Builder transport(HttpTransport v) {
            this.transport = v;
            return this;
        }

        public ClientConfig build() {
            return new ClientConfig(this);
        }
    }
}
