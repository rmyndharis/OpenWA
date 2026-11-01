package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * How {@code GET /search} matches {@code q}. {@link #WORD} (the server default) matches whole words;
 * {@link #CONTAINS} matches any part of a word, ignoring case and accents. It needs
 * {@code SEARCH_CONTAINS_ENABLED=true} and a finished index build on the server (501 otherwise) and at
 * least one term of 3+ characters with at most 64 characters across its terms (400 otherwise); it ranks
 * the 1000 most recently stored matches, so {@code total} is at most 1000. Wire values are lowercase.
 */
public enum SearchMatch {
    @SerializedName("word")
    WORD,
    @SerializedName("contains")
    CONTAINS
}
