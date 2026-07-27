package com.rmyndharis.openwa.http;

import java.util.List;
import java.util.Map;

/**
 * A raw response: status, headers, and the undecoded body bytes. Bytes (not a
 * decoded String) so binary payloads — e.g. a stored status media stream —
 * survive the transport without charset corruption; the client decodes UTF-8
 * only on the JSON/text paths.
 */
public record HttpResponseData(int status, Map<String, List<String>> headers, byte[] body) {}
