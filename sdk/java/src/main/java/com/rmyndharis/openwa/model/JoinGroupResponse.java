package com.rmyndharis.openwa.model;

/** Returned when joining a group via an invite code — carries the joined group id. */
public record JoinGroupResponse(boolean success, String groupId) {}
