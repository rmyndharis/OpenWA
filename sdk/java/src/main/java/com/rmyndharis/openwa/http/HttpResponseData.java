package com.rmyndharis.openwa.http;

import java.util.List;
import java.util.Map;

/** A raw response: status, headers, and the undecoded body text. */
public record HttpResponseData(int status, Map<String, List<String>> headers, String body) {}
