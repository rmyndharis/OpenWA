package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * Chat presence state. The wire values are lowercase, so each constant carries a
 * {@link SerializedName} mapping.
 */
public enum ChatState {
    @SerializedName("typing")
    TYPING,
    @SerializedName("recording")
    RECORDING,
    @SerializedName("paused")
    PAUSED
}
