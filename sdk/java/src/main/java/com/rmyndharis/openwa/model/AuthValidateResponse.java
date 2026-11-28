package com.rmyndharis.openwa.model;

import java.util.List;

/** Result of validating the configured API key. */
public record AuthValidateResponse(
    boolean valid, String role, String engineType, Boolean scoped, List<String> deniedPermissions) {}
