package com.rmyndharis.openwa.model;

/** A WhatsApp session. Optional fields are {@code null} when absent. */
public record SessionResponse(
    String id,
    String name,
    SessionStatus status,
    String phone,
    String pushName,
    String connectedAt,
    String lastActive,
    String createdAt,
    String updatedAt,
    /** Present when {@code status == FAILED} or {@code status == ACTION_REQUIRED}. */
    String lastError,
    /**
     * A limit WhatsApp itself has placed on the account, or {@code null} when there is none.
     * Distinct from {@code lastError}, which describes a fault on the gateway's side.
     */
    AccountRestriction restriction,
    /**
     * Whether the gateway holds a live engine for this session. The precondition the lifecycle
     * routes enforce; not derivable from {@code status}, since {@code DISCONNECTED} covers both a
     * session mid automatic-reconnect (engine present) and one stopped with no engine. {@code null}
     * from a gateway older than the field.
     */
    Boolean engineLoaded) {}
