package com.rmyndharis.openwa.model;

/**
 * A WhatsApp Business chat label. Mirrors the backend {@code Label} — returned by the engine
 * as-is, with no DTO in between. {@code hexColor} is the label colour, e.g. {@code #25D366}.
 */
public record LabelRecord(String id, String name, String hexColor) {}
