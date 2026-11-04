package com.rmyndharis.openwa.model;

/**
 * A session's effective runtime configuration.
 *
 * <p>A null {@code maxReconnectAttempts} means unlimited — not unset.
 *
 * @param autoRejectCalls whether incoming calls are auto-rejected; Baileys only, whatsapp-web.js stores
 *     the flag but cannot reject a call, so calls keep ringing there
 * @param maxReconnectAttempts cap on consecutive reconnect attempts; null means unlimited
 * @param reconnectBaseDelay base delay of the reconnect backoff, in milliseconds
 */
public record SessionConfig(Boolean autoRejectCalls, Integer maxReconnectAttempts, Integer reconnectBaseDelay) {}
