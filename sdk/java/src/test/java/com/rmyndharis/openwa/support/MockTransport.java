package com.rmyndharis.openwa.support;

import com.rmyndharis.openwa.http.HttpRequestData;
import com.rmyndharis.openwa.http.HttpResponseData;
import com.rmyndharis.openwa.http.HttpTransport;
import java.util.List;
import java.util.Map;

/** Records the last request and returns a canned response. Tests assert on {@link #lastRequest()}. */
public final class MockTransport implements HttpTransport {
    private HttpRequestData last;
    private int status = 200;
    private String body = "";

    public MockTransport respond(int status, String jsonBody) {
        this.status = status;
        this.body = jsonBody;
        return this;
    }

    public HttpRequestData lastRequest() {
        return last;
    }

    @Override
    public HttpResponseData send(HttpRequestData request) {
        this.last = request;
        return new HttpResponseData(status, Map.<String, List<String>>of(), body);
    }
}
