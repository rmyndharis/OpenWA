/**
 * The ids of the messages this session sent through the API, held until the library's own echo of
 * each comes back through `messages.upsert`.
 *
 * Baileys re-emits every own send tagged `append`, and WhatsApp replays what the account typed on
 * its phone while the gateway was down through the same tag with the same `fromMe`. The id is the
 * only thing that tells the two apart, and the adapter is the only party that knows it, because it
 * made the send. An echo is consumed once and forgotten; anything not recorded here was not sent by
 * this process and is delivered.
 *
 * Bounded, oldest first: an echo that never arrives (the library option off, a send whose id could
 * not be read back) must not leave its id behind forever on a gateway that runs for months. The
 * library echo is local and arrives within the event buffer's window, so this only has to outlast
 * that; an id evicted early, and any message WhatsApp itself re-delivers, is caught instead by the
 * persistent message store check in processInboundMessage, which does survive a restart.
 */
export class OwnSendRegistry {
  private readonly ids = new Set<string>();

  constructor(private readonly cap = 1000) {}

  get size(): number {
    return this.ids.size;
  }

  remember(id: string | null | undefined): void {
    if (!id) return;
    // Re-inserting moves the id to the newest position, so a resend is not evicted early.
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.cap) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  /** True exactly once for an id this session sent; false for anything else, including no id. */
  consume(id: string | null | undefined): boolean {
    if (!id) return false;
    return this.ids.delete(id);
  }
}
