package com.rmyndharis.openwa.model;

/** Live QR code for authenticating a session. */
public record QrCodeResponse(
    /** Data URL, e.g. {@code data:image/png;base64,…}. */
    String qrCode,
    SessionStatus status) {}
