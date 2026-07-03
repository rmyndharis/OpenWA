package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Content kind of a bulk-send item. Wire values are lowercase. */
public enum BulkMessageType {
    @SerializedName("text")
    TEXT,
    @SerializedName("image")
    IMAGE,
    @SerializedName("video")
    VIDEO,
    @SerializedName("audio")
    AUDIO,
    @SerializedName("document")
    DOCUMENT
}
