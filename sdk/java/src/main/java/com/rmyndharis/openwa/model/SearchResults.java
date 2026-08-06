package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * Payload returned by {@code GET /search}. {@code total} is a bounded exact count for pagination,
 * {@code tookMs} is the provider's wall-clock query time, and {@code provider} is the id of the
 * active search backend that answered (e.g. {@code builtin-fts}).
 */
public record SearchResults(List<SearchHit> hits, int total, long tookMs, String provider) {}
