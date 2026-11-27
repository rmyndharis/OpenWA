/**
 * An engine that hands back a message it kept for a stored message it could not read (see
 * EngineEventCallbacks.onInboundUnreadable): processed as it would have been on arrival, resolving true, or false when
 * it cannot run yet (the session is not connected). Rejects with the store's failure while that message still cannot be
 * read. Not part of IWhatsAppEngine: Baileys alone keeps such messages.
 */
export interface InboundRedelivery {
  redeliverInbound(raw: string): Promise<boolean>;
  /**
   * Write a copy of a message the database refused (see EngineEventCallbacks.onStoredCopyRefused), blank when the
   * message was deleted for everyone meanwhile (`revoked`); resolves true once written, rejects while refused.
   */
  restoreStoredCopy(raw: string, revoked: boolean): Promise<boolean>;
  /**
   * Apply an edit or delete of a stored copy the database refused (see EngineEventCallbacks.onStoredChangeRefused);
   * resolves true once applied (or nothing is left to change), rejects while refused.
   */
  restoreStoredChange(raw: string): Promise<boolean>;
}

/** Whether an engine hands back the messages it kept (see InboundRedelivery). */
export const handsBackInbound = (engine: unknown): engine is InboundRedelivery =>
  typeof (engine as Partial<InboundRedelivery> | null)?.redeliverInbound === 'function';
