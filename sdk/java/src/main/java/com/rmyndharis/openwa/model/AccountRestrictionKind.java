package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Class of a WhatsApp-side account restriction. */
public enum AccountRestrictionKind {
    @SerializedName("reachout_timelock") REACHOUT_TIMELOCK,
    @SerializedName("tos_block") TOS_BLOCK,
    @SerializedName("proxy_block") PROXY_BLOCK,
    /** Decoded when the gateway sends a value newer than this SDK; not a wire value itself. */
    UNKNOWN
}
