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
        // convert() saturates where toMillis() would throw, so a timeout too large to schedule
        // fails through the future below as an IOException like any other transport failure.
        long timeoutMs = TimeUnit.MILLISECONDS.convert(req.timeout());
        try {
            HttpResponse<byte[]> res = future.get(timeoutMs, TimeUnit.MILLISECONDS);
            return new HttpResponseData(res.statusCode(), res.headers().map(), res.body());
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new OpenWATimeoutError(timeoutMs);
        } catch (InterruptedException e) {
            future.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof HttpTimeoutException) {
                throw new OpenWATimeoutError(timeoutMs);
            }
            throw transportFailure(cause);
        }
    }

    // As HttpClient.send does: only IllegalArgumentException and SecurityException pass through
    // unchecked, so any other failure stays an IOException and reaches the caller as OpenWAError.
    static IOException transportFailure(Throwable cause) {
        if (cause instanceof IOException io) {
            return io;
        }
        if (cause instanceof IllegalArgumentException || cause instanceof SecurityException) {
            throw (RuntimeException) cause;
        }
        return new IOException(cause.getMessage(), cause);
    }
}
