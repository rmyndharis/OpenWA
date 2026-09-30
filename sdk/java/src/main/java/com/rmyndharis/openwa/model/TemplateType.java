package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Message template type. Wire values are lowercase. */
public enum TemplateType {
    @SerializedName("text")
    TEXT,
    @SerializedName("image")
    IMAGE
}
