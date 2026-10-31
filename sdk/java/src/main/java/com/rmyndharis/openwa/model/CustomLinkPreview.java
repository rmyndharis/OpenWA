package com.rmyndharis.openwa.model;

/**
 * A caller-supplied link preview, used instead of one fetched from the URL.
 *
 * <p>The page is never fetched, so a preview can be attached even for a URL the gateway cannot
 * reach; only {@code thumbnailUrl}, when given, is fetched. Baileys only — whatsapp-web.js takes a
 * boolean and answers {@code 501}.
 *
 * @param title required — WhatsApp will not render a preview without one
 * @param thumbnailUrl preview image as an http(s) URL, fetched under the media SSRF rules; renders the
 *     large card. At most 5 MiB.
 * @param thumbnailBase64 preview image as base64, at most 5 MiB decoded; wins over {@code thumbnailUrl}
 */
public record CustomLinkPreview(
    String url, String title, String description, String thumbnailUrl, String thumbnailBase64) {
    /** Back-compatible constructor without a preview image. */
    public CustomLinkPreview(String url, String title, String description) {
        this(url, title, description, null, null);
    }
}
