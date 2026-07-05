package com.rmyndharis.openwa.http;

import com.rmyndharis.openwa.errors.OpenWATimeoutError;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;

/** Default transport backed by {@link java.net.http.HttpClient}. Never follows redirects. */
public final class DefaultHttpTransport implements HttpTransport {
    private final HttpClient client = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .build();

    @Override
    public HttpResponseData send(HttpRequestData req) throws IOException, InterruptedException {
        HttpRequest.BodyPublisher pub = req.body() == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofString(req.body());
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(req.url()))
            .timeout(req.timeout())
            .method(req.method().name(), pub);
        req.headers().forEach(b::header);
        try {
            HttpResponse<String> res = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new HttpResponseData(res.statusCode(), res.headers().map(), res.body());
        } catch (HttpTimeoutException e) {
            throw new OpenWATimeoutError(req.timeout().toMillis());
        }
    }
}
