package com.rmyndharis.openwa.model;

/**
 * The shareable WhatsApp call link.
 *
 * @param link the finished {@code https://call.whatsapp.com/…} URL
 */
public record CallLinkResponse(String link) {}
