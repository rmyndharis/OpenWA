package com.rmyndharis.openwa.model;

/** WhatsApp Business catalog metadata. Optional fields are {@code null} when absent. */
public record CatalogInfo(
    String id,
    String name,
    String description,
    int productCount,
    String url) {}
