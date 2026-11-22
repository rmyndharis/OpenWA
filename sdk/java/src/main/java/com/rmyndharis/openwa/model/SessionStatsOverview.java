package com.rmyndharis.openwa.model;

import java.util.Map;

/**
 * Aggregate statistics across the API key's sessions.
 * {@code memoryUsage} is {@code null} unless the caller uses an unscoped ADMIN key.
 */
public record SessionStatsOverview(
    int total,
    int active,
    int ready,
    int disconnected,
    Map<String, Integer> byStatus,
    MemoryUsage memoryUsage) {

    /** Process memory snapshot, in MiB (rounded). */
    public record MemoryUsage(long heapUsed, long heapTotal, long rss) {}
}
