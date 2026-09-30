package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * How a pending member asked to join a group. The wire values are snake_case, so each constant
 * carries a {@link SerializedName} mapping.
 */
public enum MembershipRequestMethod {
    @SerializedName("invite_link")
    INVITE_LINK,
    @SerializedName("linked_group_join")
    LINKED_GROUP_JOIN,
    @SerializedName("non_admin_add")
    NON_ADMIN_ADD,
    /** Decoded when the gateway sends a value newer than this SDK; not a wire value itself. */
    UNKNOWN
}
