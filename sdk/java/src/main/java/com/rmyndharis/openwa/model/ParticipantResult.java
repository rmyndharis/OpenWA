package com.rmyndharis.openwa.model;

/**
 * One entry per requested participant, in the order they were requested.
 *
 * <p>{@code success} is true only when the engine confirmed the change for this participant. Engines
 * that confirm the batch rather than each member report one success entry per requested id, so a
 * true here does not always mean the engine spoke about that participant individually.
 *
 * @param id neutral participant id the outcome belongs to
 * @param success whether the engine confirmed the change for this participant
 * @param status the engine's own status code, when it gave one
 */
public record ParticipantResult(String id, boolean success, Integer status, String message) {}
