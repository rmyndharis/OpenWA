package com.rmyndharis.openwa.model;

import java.util.List;

/** Message receipts response with per-participant delivery, read, and played lists. */
public record MessageReceiptsResponse(
    List<MessageReceiptParticipant> delivery,
    Integer deliveryRemaining,
    List<MessageReceiptParticipant> read,
    Integer readRemaining,
    List<MessageReceiptParticipant> played,
    Integer playedRemaining
) {}
