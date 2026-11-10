package com.rmyndharis.openwa.model;

/**
 * A restriction WhatsApp has in force on a session's account.
 *
 * <p>{@code reachout_timelock} leaves the session connected and existing chats working — only
 * starting new conversations is blocked — whereas {@code tos_block}, {@code proxy_block} and
 * {@code passkey_required} stop a link or the connection itself and therefore cannot coexist with a
 * {@code READY} status. {@code passkey_required} means WhatsApp asked for a passkey to finish linking
 * a device, which the Baileys engine cannot answer.
 *
 * @param kind one of {@code reachout_timelock}, {@code tos_block}, {@code proxy_block},
 *     {@code passkey_required}
 * @param code the engine's own token for the cause, verbatim ({@code TOS_BLOCK}, {@code BIZ_QUALITY}, …)
 * @param expiresAt ISO timestamp for the end of enforcement, when WhatsApp states one
 */
public record AccountRestriction(AccountRestrictionKind kind, String code, String expiresAt) {}
