package com.rmyndharis.openwa.model;

/** Per-message outcome within a batch result list. Optional fields are {@code null} when absent. */
public record BatchMessageResult(
    String chatId,
    String status,
    String messageId,
    String sentAt,
    BatchError error) {

    public record BatchError(String code, String message) {}
}
