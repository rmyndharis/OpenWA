package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Delivery status for a message. Wire values are lowercase. */
public enum DeliveryStatus {
    @SerializedName("pending")
    PENDING,
    @SerializedName("sent")
    SENT,
    @SerializedName("delivered")
    DELIVERED,
    @SerializedName("read")
    READ,
    @SerializedName("failed")
    FAILED
}
