package com.rmyndharis.openwa;

import com.rmyndharis.openwa.http.HttpTransport;
import java.net.URI;
import java.net.URISyntaxException;
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
        String url = b.baseUrl == null ? null : b.baseUrl.strip();
        if (url == null || url.isEmpty()) {
            throw new IllegalArgumentException("OpenWAClient: baseUrl is required");
        }
        try {
            new URI(url);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("OpenWAClient: baseUrl is not a valid URL: " + url);
        }
        String key = b.apiKey == null ? null : b.apiKey.strip();
        if (key == null || key.isEmpty()) {
            throw new IllegalArgumentException("OpenWAClient: apiKey is required");
        }
        if (hasControlChar(key)) {
            throw new IllegalArgumentException(
                "OpenWAClient: apiKey contains illegal characters (whitespace or control) — check for a stray newline");
        }
        if (b.timeout != null && (b.timeout.isZero() || b.timeout.isNegative())) {
            throw new IllegalArgumentException("OpenWAClient: timeout must be positive");
        }
        warnIfInsecureHttp(url);
        // baseUrl/apiKey are stripped so a trailing newline from a file/env var can't break the request.
        this.baseUrl = url;
        this.apiKey = key;
        this.timeout = b.timeout != null ? b.timeout : Duration.ofSeconds(30);
        this.defaultHeaders = b.defaultHeaders != null ? b.defaultHeaders : Map.of();
        this.transport = b.transport;
    }

    private static boolean hasControlChar(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                return true;
            }
        }
        return false;
    }

    /**
     * Warn (not throw) when baseUrl is {@code http://} and the host is not localhost. The API key
     * is sent as an {@code X-API-Key} header on every request — over plaintext http to a non-local
     * host that's cleartext on the wire. Warning (not refusing) keeps local dev and
     * TLS-terminating-proxy topologies working.
     */
    private static void warnIfInsecureHttp(String url) {
        try {
            URI uri = new URI(url);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if ("http".equalsIgnoreCase(scheme) && host != null) {
                String h = host.replaceAll("^\\[|\\]$", "").toLowerCase();
                if (!h.equals("localhost") && !h.equals("127.0.0.1") && !h.equals("::1")) {
                    System.err.println(
                        "[OpenWA SDK] WARNING: baseUrl uses an insecure http:// URL (host: " + host + "). "
                            + "The API key will be sent in cleartext. Use https:// in production.");
                }
            }
        } catch (URISyntaxException e) {
            // Already validated above — a repeat failure here is a no-op.
        }
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
