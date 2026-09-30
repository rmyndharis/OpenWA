package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** One recipient's send outcome inside a batch. */
public enum BatchMessageStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("sent") SENT,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED,
    /** Decoded when the gateway sends a value newer than this SDK; not a wire value itself. */
    UNKNOWN
}
