package com.rmyndharis.openwa.http;

/**
 * A binary (non-JSON) 2xx body, e.g. the stored status media bytes: the raw
 * payload plus the Content-Type the server served it as ({@code null} when the
 * response carried no Content-Type header or was empty).
 */
public record BinaryResponse(byte[] data, String contentType) {}
