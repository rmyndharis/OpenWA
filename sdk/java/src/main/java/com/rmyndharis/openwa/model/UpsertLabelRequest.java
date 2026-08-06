package com.rmyndharis.openwa.model;

/**
 * A label create-or-update body. The id travels in the path, because WhatsApp keys the write on it.
 *
 * @param name {@code null} leaves the current name alone
 * @param color WhatsApp's colour INDEX (0-19), NOT a hex value — it does not round-trip with the
 *     {@code hexColor} labels are read back with, because neither engine exposes the mapping;
 *     {@code null} leaves the current colour alone
 */
public record UpsertLabelRequest(String name, Integer color) {}
