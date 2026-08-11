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
    @SerializedName("message.edited")
    MESSAGE_EDITED,
    @SerializedName("session.status")
    SESSION_STATUS,
    @SerializedName("session.qr")
    SESSION_QR,
    @SerializedName("session.authenticated")
    SESSION_AUTHENTICATED,
    @SerializedName("session.disconnected")
    SESSION_DISCONNECTED,
    @SerializedName("session.reconnect_loop")
    SESSION_RECONNECT_LOOP,
    @SerializedName("session.restriction")
    SESSION_RESTRICTION,
    @SerializedName("presence.update")
    PRESENCE_UPDATE,
    @SerializedName("call.accepted")
    CALL_ACCEPTED,
    @SerializedName("call.rejected")
    CALL_REJECTED,
    @SerializedName("call.missed")
    CALL_MISSED,
    @SerializedName("group.join")
    GROUP_JOIN,
    @SerializedName("group.leave")
    GROUP_LEAVE,
    @SerializedName("group.update")
    GROUP_UPDATE,
    @SerializedName("group.join_request")
    GROUP_JOIN_REQUEST,
    @SerializedName("call.received")
    CALL_RECEIVED,
    @SerializedName("status.received")
    STATUS_RECEIVED,
    @SerializedName("*")
    ALL
}
