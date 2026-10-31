package com.rmyndharis.openwa.model;

/**
 * Outcome of replaying recorded webhook deliveries.
 *
 * @param redriven rows replayed by this call: delivered plus enqueued
 * @param delivered delivered by a direct POST; their failure rows were removed
 * @param enqueued reserved for compatibility; operator redrive always returns zero
 * @param failed replays that failed again; their rows stay, with attempts raised by one
 * @param skipped selected rows not replayed: a hook cancelled the replay, or the row or its webhook
 *     changed during the call; rows of a removed, disabled or unsubscribed webhook are left out before
 *     the batch and not counted
 * @param remaining rows the redrive would still take after this call: replayable, in scope, with an
 *     active subscribed webhook
 */
public record WebhookRedriveResult(
    int redriven, int delivered, int enqueued, int failed, int skipped, int remaining) {}
