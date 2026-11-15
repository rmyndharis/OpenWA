package com.rmyndharis.openwa.model;

/**
 * A session's effective runtime configuration.
 *
 * <p>A null {@code maxReconnectAttempts} means unlimited — not unset; a null {@code linkPreview} means
 * the engine's own default.
 *
 * @param autoRejectCalls whether incoming calls are auto-rejected; Baileys only, whatsapp-web.js stores
 *     the flag but cannot reject a call, so calls keep ringing there
 * @param maxReconnectAttempts cap on consecutive reconnect attempts; null means unlimited
 * @param reconnectBaseDelay base delay of the reconnect backoff, in milliseconds
 * @param linkPreview link preview of a send-text or send-template that sets none; null keeps the engine's default
 */
public record SessionConfig(
        Boolean autoRejectCalls, Integer maxReconnectAttempts, Integer reconnectBaseDelay, Boolean linkPreview) {

    /** Back-compatible constructor without {@code linkPreview}. */
    public SessionConfig(Boolean autoRejectCalls, Integer maxReconnectAttempts, Integer reconnectBaseDelay) {
        this(autoRejectCalls, maxReconnectAttempts, reconnectBaseDelay, null);
    }
}
