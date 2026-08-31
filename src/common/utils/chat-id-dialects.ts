/**
 * Both spellings of a user id. Stored rows carry either dialect — inbound rows are neutralized to
 * `@c.us`, outbound rows keep the caller's raw form — so a byte-exact history probe misreads a
 * known contact addressed the other way as cold. Non-user ids (groups, lids, …) pass through
 * unchanged; a lid has no derivable phone twin to probe.
 *
 * Shared rather than per-service: the send pacing cold-contact probe and the automation rules'
 * chat-history gates ask the same question of the same table, and a second copy would be one
 * bug fix away from disagreeing about who counts as a known contact.
 */
export function dialectVariants(chatId: string): string[] {
  const lower = chatId.toLowerCase();
  if (lower.endsWith('@c.us')) {
    return [chatId, chatId.slice(0, chatId.length - '@c.us'.length) + '@s.whatsapp.net'];
  }
  if (lower.endsWith('@s.whatsapp.net')) {
    return [chatId, chatId.slice(0, chatId.length - '@s.whatsapp.net'.length) + '@c.us'];
  }
  // A bare number is a user id with the suffix left off — the group-participant endpoints accept
  // one and the engines qualify it themselves, so the history probe has to look under both
  // spellings too or a contact the account already knows is charged as a stranger.
  if (/^\d{5,}$/.test(chatId.trim())) {
    const digits = chatId.trim();
    return [digits, `${digits}@c.us`, `${digits}@s.whatsapp.net`];
  }
  return [chatId];
}
