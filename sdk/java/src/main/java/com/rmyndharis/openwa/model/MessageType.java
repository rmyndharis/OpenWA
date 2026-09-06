package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** The engine-normalized message kind. */
public enum MessageType {
    @SerializedName("text") TEXT,
    @SerializedName("image") IMAGE,
    @SerializedName("video") VIDEO,
    @SerializedName("audio") AUDIO,
    @SerializedName("voice") VOICE,
    @SerializedName("document") DOCUMENT,
    @SerializedName("sticker") STICKER,
    @SerializedName("location") LOCATION,
    @SerializedName("contact") CONTACT,
    @SerializedName("poll") POLL,
    @SerializedName("call") CALL,
    @SerializedName("revoked") REVOKED,
    @SerializedName("order") ORDER,
    @SerializedName("product") PRODUCT,
    @SerializedName("masked") MASKED,
    @SerializedName("unknown") UNKNOWN
}
