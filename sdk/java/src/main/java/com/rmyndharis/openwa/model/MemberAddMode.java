package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Who may add participants to a group. */
public enum MemberAddMode {
    @SerializedName("all") ALL,
    @SerializedName("admins") ADMINS,
    /** Decoded when the gateway sends a value newer than this SDK; not a wire value itself. */
    UNKNOWN
}
