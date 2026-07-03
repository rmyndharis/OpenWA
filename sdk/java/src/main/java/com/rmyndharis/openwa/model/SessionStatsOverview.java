package com.rmyndharis.openwa.model;

import java.util.Map;

/** Aggregate statistics across the API key's sessions. */
public record SessionStatsOverview(
    int total,
    int active,
    int ready,
    int disconnected,
    Map<String, Integer> byStatus,
    MemoryUsage memoryUsage) {

    /** Process memory snapshot (bytes). */
    public record MemoryUsage(long heapUsed, long heapTotal, long rss) {}
}
