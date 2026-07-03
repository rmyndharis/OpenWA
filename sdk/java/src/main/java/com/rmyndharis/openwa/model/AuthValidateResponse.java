package com.rmyndharis.openwa.model;

/** Result of validating the configured API key. */
public record AuthValidateResponse(boolean valid, String role) {}
