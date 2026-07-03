package com.rmyndharis.openwa.http;

import java.io.IOException;

/**
 * The SDK's single I/O seam. The client depends on this interface, never on a
 * concrete HTTP library — tests inject a recording implementation that captures
 * the request and returns a canned response.
 */
@FunctionalInterface
public interface HttpTransport {
    HttpResponseData send(HttpRequestData request) throws IOException, InterruptedException;
}
