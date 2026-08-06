package com.rmyndharis.openwa.model;

import java.util.List;

/** Wrapper returned by the GET status endpoints: {@code { statuses: [...] }}. */
public record StatusListResult(List<StatusRecord> statuses) {}
