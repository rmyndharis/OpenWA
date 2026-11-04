package com.rmyndharis.openwa.model;

/**
 * WhatsApp Business catalog metadata. Optional fields are {@code null} when absent.
 * {@code productCount} counts at most the first 51 products on Baileys.
 */
public record CatalogInfo(
    String id,
    String name,
    String description,
    int productCount,
    String url) {}
