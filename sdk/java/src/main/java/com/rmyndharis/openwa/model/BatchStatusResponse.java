package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * Response from {@code GET /messages/batch/:batchId} (batch status polling) and
 * {@code POST /messages/batch/:batchId/cancel}. Distinct from {@link BulkMessageResponse}
 * (the send-bulk acknowledgement). Optional fields are {@code null} when absent.
 */
public record BatchStatusResponse(
    String batchId,
    String status,
    BatchProgress progress,
    List<BatchMessageResult> results,
    String startedAt,
    String completedAt) {}
