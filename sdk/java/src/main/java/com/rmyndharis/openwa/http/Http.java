package com.rmyndharis.openwa.http;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.StringJoiner;

/** Pure helpers for URL construction and header merging (no I/O). */
public final class Http {
    private Http() {}

    /** Percent-encode a path segment, keeping WhatsApp-id chars {@code @ : +} readable. */
    public static String encodeSegment(String segment) {
        // URLEncoder is form-encoding: it encodes space as '+'. Restore true
        // percent-encoding first, then keep already-path-safe WhatsApp-id chars readable.
        String enc = URLEncoder.encode(segment, StandardCharsets.UTF_8).replace("+", "%20");
        return enc.replace("%40", "@").replace("%3A", ":").replace("%2B", "+");
    }

    /** Build an absolute URL, preserving a base path prefix and omitting null query values. */
    public static String buildUrl(String baseUrl, String path, Object query, Gson gson) {
        String base = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        String url = base + path;
        if (query == null) {
            return url;
        }
        StringJoiner qs = new StringJoiner("&");
        for (Map.Entry<String, JsonElement> e : gson.toJsonTree(query).getAsJsonObject().entrySet()) {
            JsonElement v = e.getValue();
            if (v == null || v.isJsonNull()) {
                continue;
            }
            String value = v.isJsonPrimitive() ? v.getAsString() : v.toString();
            qs.add(encodeQuery(e.getKey()) + "=" + encodeQuery(value));
        }
        String q = qs.toString();
        return q.isEmpty() ? url : url + "?" + q;
    }

    private static String encodeQuery(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    /** Merge headers so auth + JSON content-type always win over caller-supplied headers. */
    public static Map<String, String> mergeHeaders(Map<String, String> defaults, Map<String, String> perRequest, String apiKey) {
        Map<String, String> out = new LinkedHashMap<>();
        if (defaults != null) {
            out.putAll(defaults);
        }
        if (perRequest != null) {
            out.putAll(perRequest);
        }
        out.put("Content-Type", "application/json");
        out.put("X-API-Key", apiKey);
        return out;
    }
}
