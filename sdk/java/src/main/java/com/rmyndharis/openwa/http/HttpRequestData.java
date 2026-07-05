package com.rmyndharis.openwa.http;

import java.time.Duration;
import java.util.Map;

/** A fully-resolved outbound request (absolute URL, final headers, serialized body). */
public record HttpRequestData(HttpMethod method, String url, Map<String, String> headers, String body, Duration timeout) {}
