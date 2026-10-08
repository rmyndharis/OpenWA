package com.rmyndharis.openwa.http;

import com.rmyndharis.openwa.errors.OpenWATimeoutError;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

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
        // The request timeout only covers the wait for response headers; bounding the future
        // also covers a server that stalls while sending the body.
        CompletableFuture<HttpResponse<byte[]>> future =
            client.sendAsync(b.build(), HttpResponse.BodyHandlers.ofByteArray());
        try {
            HttpResponse<byte[]> res = future.get(req.timeout().toMillis(), TimeUnit.MILLISECONDS);
            return new HttpResponseData(res.statusCode(), res.headers().map(), res.body());
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new OpenWATimeoutError(req.timeout().toMillis());
        } catch (InterruptedException e) {
            future.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof HttpTimeoutException) {
                throw new OpenWATimeoutError(req.timeout().toMillis());
            }
            if (cause instanceof IOException io) {
                throw io;
            }
            if (cause instanceof RuntimeException re) {
                throw re;
            }
            throw new IOException(cause.getMessage(), cause);
        }
    }
}
