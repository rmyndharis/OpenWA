/**
 * Response descriptions shared by every route that reaches a WhatsApp engine.
 *
 * Kept in one place rather than repeated per controller: the text describes the engine's own
 * behaviour, not any one route's, so eleven copies would drift apart the moment one of them was
 * reworded — which is how the contract fell behind the code in the first place.
 */

/**
 * `EngineNotReadyError` (409) — thrown by every adapter's `ensureReady()` guard, which each engine
 * method calls before touching the socket or the page. The guard fires when an engine EXISTS but is
 * not `READY`; a session with no engine at all never reaches it, because the service resolves the
 * engine first and throws `400 Session is not started`. Distinct too from the 409 the session, auth
 * and plugin routes declare, which reports a semantic conflict — a name already taken, a plugin
 * already installed, a session already running.
 */
export const ENGINE_NOT_READY_409 =
  'The session is not connected — an engine exists for it but is not `ready`: disconnected, ' +
  'reconnecting, or still initializing, so the request never reached WhatsApp. Wait for `ready` and ' +
  'retry. A session that was never started answers `400` instead, and the session lifecycle routes ' +
  'answer `409` for a conflicting state rather than this. One window answers this while the session ' +
  'still reads `ready`: WhatsApp Web periodically reloads its own page and the engine re-injects ' +
  'into it — for those few seconds the answer is a `409` naming the reload; retry shortly.';

/**
 * The catalog and status services pass a `NotFoundException` factory to `EngineRegistry.require()`
 * instead of taking its `BadRequestException` default, so on those routes an unstarted session is a
 * 404 rather than the 400 every other engine module answers. Documented rather than changed: the
 * status code is the contract those routes already have.
 */
export const SESSION_NOT_STARTED_404 =
  'No session is running under that id — it was never started, was stopped, or does not exist. These ' +
  'routes report an unstarted session as `404`, where the message and group routes report it as `400`.';

/**
 * `RecipientUnreachableError` (400) — whatsapp-web.js could not resolve the recipient to an
 * addressable id, so the send never left the gateway. The wording stays non-exclusive: 400 is also
 * what body validation and an inactive session answer on these routes, and the earlier text claimed
 * a 404 meaning that four of the six routes carrying this constant do not even declare.
 */
export const RECIPIENT_UNREACHABLE_400 =
  'The request was rejected before anything was sent. Among the causes: the recipient could not be ' +
  'addressed — WhatsApp reports no deliverable id for that `chatId`, which is how it says the number ' +
  'is not on WhatsApp — as well as body validation and a session that is not active.';

/** `EngineRefusedError` (403) — the request was well formed; WhatsApp itself refused it. */
export const ENGINE_REFUSED_403 =
  'WhatsApp refused the operation. The request was well formed — the refusal happened WhatsApp-side, ' +
  'most often because the account lacks the admin rights the operation requires.';

/** `MessageNotFoundError` (404) — outside the adapter's lookup window, or revoked. */
export const MESSAGE_NOT_FOUND_404 =
  "No such message — the id is outside the engine's lookup window (roughly the last hundred messages " +
  'of the chat, or absent from the Baileys store) or the message was revoked.';

/** `ChannelNotFoundError` (404), on routes addressed by channel id. */
export const CHANNEL_NOT_FOUND_404 =
  "No such channel — the id is not among the session's subscribed channels, either because it is " +
  'wrong or because the channel has not synced into the local collection yet.';

/**
 * `ChannelNotFoundError` (404) on `POST /channels/subscribe`, which takes an invite code and no
 * channel id at all — so the id-based wording above would describe the wrong thing.
 */
export const CHANNEL_INVITE_NOT_FOUND_404 =
  'The invite code does not resolve to a channel — it is wrong, expired, or revoked. This route takes ' +
  'an invite code rather than a channel id.';

/**
 * `EngineNotSupportedError` (501) on `POST /messages/send-text`, which is supported by both engines;
 * only the caller-supplied link preview is not. The generic engine-wide wording would overstate it.
 */
export const CUSTOM_LINK_PREVIEW_501 =
  'A caller-supplied `customLinkPreview` is not supported by the whatsapp-web.js engine — only ' +
  'Baileys can attach one. The send itself is supported on both; omit the field, or use `linkPreview`.';

/** `GroupNotFoundError` (404) — unknown id, or an id that addresses a 1:1 chat. */
export const GROUP_NOT_FOUND_404 = 'No such group — the id is unknown, or it addresses a 1:1 chat rather than a group.';

/** `LabelNotFoundError` (404) — never created, or the account is not a Business one. */
export const LABEL_NOT_FOUND_404 =
  'No such label — it was never created, or the account is not a WhatsApp Business one and holds no ' +
  'labels at all. Both are the same answer to the caller.';

/** `EngineNotSupportedError` (501) — in the engine contract, but not implementable on this engine. */
export const ENGINE_NOT_SUPPORTED_501 =
  'The active engine cannot serve this operation. It is part of the engine contract, but the engine ' +
  'currently running has no implementation for it.';

/** `ChannelMediaNotSupportedError` (501) — media to an `@newsletter` recipient on whatsapp-web.js. */
export const CHANNEL_MEDIA_501 =
  'Sending media to a channel (`<id>@newsletter`) is not supported by the whatsapp-web.js engine — ' +
  'the page method it needs was removed by a WhatsApp Web update. Text to a channel still works.';
