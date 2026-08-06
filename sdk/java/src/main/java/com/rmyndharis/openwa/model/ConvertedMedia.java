package com.rmyndharis.openwa.model;

/**
 * Converted media, shaped for handing straight to a send call.
 *
 * @param base64 the converted bytes, ready to use as a send call's base64
 * @param mimetype what the bytes now are — not what they were
 * @param bytes decoded size, so a size check needs no decoding
 */
public record ConvertedMedia(String base64, String mimetype, long bytes) {}
