package com.rmyndharis.openwa.model;

/**
 * A restriction WhatsApp has in force on a session's account.
 *
 * <p>{@code reachout_timelock} leaves the session connected and existing chats working — only
 * starting new conversations is blocked — whereas {@code tos_block} and {@code proxy_block} refuse
 * the connection itself and therefore cannot coexist with a {@code READY} status.
 *
 * @param kind one of {@code reachout_timelock}, {@code tos_block}, {@code proxy_block}
 * @param code the engine's own token for the cause, verbatim ({@code TOS_BLOCK}, {@code BIZ_QUALITY}, …)
 * @param expiresAt ISO timestamp for the end of enforcement, when WhatsApp states one
 */
public record AccountRestriction(String kind, String code, String expiresAt) {}
