package com.rmyndharis.openwa.model;

/**
 * A pending request to join a group.
 *
 * <p>Only {@code participantId} is always present; the engine reports the rest when it has it, so
 * treat the other fields as possibly {@code null} rather than assuming a shape.
 *
 * @param participantId neutral id of the user asking to join
 * @param addedById who created the request — differs from the requester on a non-admin add
 * @param method one of {@code invite_link}, {@code non_admin_add}, {@code linked_group_join}
 * @param requestedAt Unix seconds the request was created
 */
public record GroupMembershipRequest(String participantId, String addedById, String method, Double requestedAt) {}
