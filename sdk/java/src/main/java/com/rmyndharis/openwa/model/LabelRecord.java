package com.rmyndharis.openwa.model;

/** A WhatsApp Business chat label. Optional fields are {@code null} when absent. */
public record LabelRecord(String id, String name, String color, String colorHex) {}
