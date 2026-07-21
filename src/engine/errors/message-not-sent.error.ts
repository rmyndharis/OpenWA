/**
 * Raised when WhatsApp accepted the request but produced no message.
 *
 * whatsapp-web.js signals this by *returning undefined* rather than throwing — `sendMessage` ends with
 * `return sentMsg ? new Message(this, sentMsg) : undefined;`, and returns early with `null` when the chat
 * cannot be resolved. Dereferencing that result gives "Cannot read properties of undefined (reading 'id')",
 * which reaches the caller as an opaque 500 with no clue what went wrong.
 *
 * Carried as its own type so the API layer can answer with 400 and the actual reason: the request was
 * well-formed, but the recipient could not be reached.
 */
export class MessageNotSentError extends Error {
  constructor(
    readonly chatId: string,
    reason?: string,
  ) {
    // Deliberately hedged. whatsapp-web.js collapses two distinct causes into one falsy return — the chat
    // could not be opened, or the send produced no message — and gives no way to tell them apart from
    // outside. Asserting a single cause here sends operators to check things that are already correct.
    super(
      reason ??
        `WhatsApp produced no message for ${chatId}. The send returned nothing, which usually means the ` +
          `chat could not be opened. Check the number is on WhatsApp and in full international form ` +
          `(e.g. 263771234567@c.us). Note a session may be unable to message its own number.`,
    );
    this.name = 'MessageNotSentError';
  }
}
