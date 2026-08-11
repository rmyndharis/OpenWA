package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * Response of the group membership writes.
 *
 * <p>A partial refusal does NOT fail the batch — the request answers 200 and reports the
 * per-participant outcome in {@code results}, so {@code success} alone hides a member that was
 * rejected.
 *
 * @param success always true; a failure is reported as a non-2xx status
 * @param message human-readable summary
 * @param results one entry per requested participant
 */
public record ParticipantsResult(boolean success, String message, List<ParticipantResult> results) {}
