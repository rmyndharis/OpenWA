package com.rmyndharis.openwa.model;

/**
 * Media to convert. Set exactly one of {@code url} or {@code base64}; {@code base64} wins when both
 * are given. No mimetype is carried — the input format is read from the bytes.
 */
public record ConvertMediaRequest(String url, String base64) {
    /** Convert media the server will fetch itself (SSRF-guarded). */
    public static ConvertMediaRequest ofUrl(String url) {
        return new ConvertMediaRequest(url, null);
    }

    /** Convert media supplied inline. */
    public static ConvertMediaRequest ofBase64(String base64) {
        return new ConvertMediaRequest(null, base64);
    }
}
