package com.rmyndharis.openwa.model;

/**
 * The {@code @lid} WhatsApp holds for a phone number. {@code lid} is {@code null} when it holds none, which an
 * unregistered number also answers.
 */
public record ContactLidResponse(String number, String lid) {}
