package com.rmyndharis.openwa.model;

/**
 * A caller-supplied link preview, used instead of one fetched from the URL.
 *
 * <p>Nothing is fetched for these, so a preview can be attached even for a URL the gateway cannot
 * reach. Baileys only — whatsapp-web.js takes a boolean and answers {@code 501}.
 *
 * @param title required — WhatsApp will not render a preview without one
 */
public record CustomLinkPreview(String url, String title, String description) {}
