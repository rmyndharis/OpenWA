package com.rmyndharis.openwa.model;

/** Whose story a {@link StatusRecord} belongs to. Optional fields are {@code null} when absent. */
public record StatusContact(String id, String name, String pushName) {}
