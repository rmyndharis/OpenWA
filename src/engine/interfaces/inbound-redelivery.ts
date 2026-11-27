/**
 * An engine that hands back a message it kept for a stored message it could not read (see
 * EngineEventCallbacks.onInboundUnreadable): processed as it would have been on arrival, resolving true, or false when
 * it cannot run yet (the session is not connected). Rejects with the store's failure while that message still cannot be
 * read. Not part of IWhatsAppEngine: Baileys alone keeps such messages.
 */
export interface InboundRedelivery {
  redeliverInbound(raw: string): Promise<boolean>;
}

/** Whether an engine hands back the messages it kept (see InboundRedelivery). */
export const handsBackInbound = (engine: unknown): engine is InboundRedelivery =>
  typeof (engine as Partial<InboundRedelivery> | null)?.redeliverInbound === 'function';
