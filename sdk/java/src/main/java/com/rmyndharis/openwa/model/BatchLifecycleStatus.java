package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Lifecycle of a whole bulk-send batch. */
public enum BatchLifecycleStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("processing") PROCESSING,
    @SerializedName("completed") COMPLETED,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED,
    /** Decoded when the gateway sends a value newer than this SDK; not a wire value itself. */
    UNKNOWN
}
