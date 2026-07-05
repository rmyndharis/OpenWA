package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * Session lifecycle status. The wire values are lowercase/snake_case, so each
 * constant carries a {@link SerializedName} mapping.
 */
public enum SessionStatus {
    @SerializedName("created")
    CREATED,
    @SerializedName("initializing")
    INITIALIZING,
    @SerializedName("qr_ready")
    QR_READY,
    @SerializedName("authenticating")
    AUTHENTICATING,
    @SerializedName("ready")
    READY,
    @SerializedName("disconnected")
    DISCONNECTED,
    @SerializedName("failed")
    FAILED
}
