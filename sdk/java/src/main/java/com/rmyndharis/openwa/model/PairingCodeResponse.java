package com.rmyndharis.openwa.model;

/** An 8-character pairing code for phone-based login. */
public record PairingCodeResponse(
    /** 8-character code, e.g. {@code ABCD1234}. */
    String pairingCode,
    String status) {}
