package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * Events a webhook may subscribe to. Use {@link #ALL} to receive all. The wire
 * values are dotted lowercase strings, so each constant carries a
 * {@link SerializedName} mapping.
 */
public enum WebhookEvent {
    @SerializedName("message.received")
    MESSAGE_RECEIVED,
    @SerializedName("message.sent")
    MESSAGE_SENT,
    @SerializedName("message.ack")
    MESSAGE_ACK,
    @SerializedName("message.failed")
    MESSAGE_FAILED,
    @SerializedName("message.revoked")
    MESSAGE_REVOKED,
    @SerializedName("message.reaction")
    MESSAGE_REACTION,
    @SerializedName("session.status")
    SESSION_STATUS,
    @SerializedName("session.qr")
    SESSION_QR,
    @SerializedName("session.authenticated")
    SESSION_AUTHENTICATED,
    @SerializedName("session.disconnected")
    SESSION_DISCONNECTED,
    // Reserved: accepted on subscribe but not dispatched yet.
    @SerializedName("group.join")
    GROUP_JOIN,
    @SerializedName("group.leave")
    GROUP_LEAVE,
    @SerializedName("group.update")
    GROUP_UPDATE,
    @SerializedName("*")
    ALL
}
