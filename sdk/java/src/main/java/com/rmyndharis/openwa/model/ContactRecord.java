package com.rmyndharis.openwa.model;

/** A contact known to a session. Optional fields are {@code null} when absent. */
public record ContactRecord(
    String id,
    String name,
    String number,
    String pushname,
    Boolean isBusiness,
    Boolean isMyContact) {}
