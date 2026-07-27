package com.rmyndharis.openwa.support;

import com.rmyndharis.openwa.http.HttpRequestData;
import com.rmyndharis.openwa.http.HttpResponseData;
import com.rmyndharis.openwa.http.HttpTransport;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Records the last request and returns a canned response. Tests assert on {@link #lastRequest()}. */
public final class MockTransport implements HttpTransport {
    private HttpRequestData last;
    private int status = 200;
    private byte[] body = new byte[0];
    private Map<String, List<String>> headers = Map.of();

    public MockTransport respond(int status, String jsonBody) {
        this.status = status;
        this.body = jsonBody.getBytes(StandardCharsets.UTF_8);
        this.headers = Map.of();
        return this;
    }

    /** Respond with a raw (non-JSON) body and explicit headers — e.g. a binary media stream. */
    public MockTransport respondRaw(int status, byte[] body, Map<String, List<String>> headers) {
        this.status = status;
        this.body = body;
        this.headers = headers;
        return this;
    }

    public HttpRequestData lastRequest() {
        return last;
    }

    @Override
    public HttpResponseData send(HttpRequestData request) {
        this.last = request;
        return new HttpResponseData(status, headers, body);
    }
}
