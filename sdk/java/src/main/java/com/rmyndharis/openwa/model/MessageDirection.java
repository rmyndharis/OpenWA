package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Message direction. Wire values are lowercase. */
public enum MessageDirection {
    @SerializedName("incoming")
    INCOMING,
    @SerializedName("outgoing")
    OUTGOING
}
