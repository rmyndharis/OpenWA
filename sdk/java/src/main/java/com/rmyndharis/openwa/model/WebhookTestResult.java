package com.rmyndharis.openwa.model;

/** Result of a test dispatch to a webhook URL. Optional fields are {@code null} when absent. */
public record WebhookTestResult(boolean success, Integer statusCode, String error) {}
