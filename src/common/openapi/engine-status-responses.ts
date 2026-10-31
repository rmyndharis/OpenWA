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
  'The session is not connected: an engine exists for it but is not `ready`, meaning disconnected, ' +
  'reconnecting, or still initializing, so the request never reached WhatsApp. Wait for `ready` and ' +
  'retry. A session that was never started answers `400` instead, and the session lifecycle routes ' +
  'answer `409` for a conflicting state rather than this. One window answers this while the session ' +
  'still reads `ready`: WhatsApp Web periodically reloads its own page and the engine re-injects ' +
  'into it, and for those few seconds the answer is a `409` naming the reload; retry shortly.';

/**
 * `EngineRegistry.require()`'s default `BadRequestException` (400): the session has no engine at all,
 * the case ENGINE_NOT_READY_409 leaves out. The catalog and status routes answer this with a 404
 * instead; see SESSION_NOT_STARTED_404.
 */
export const SESSION_NOT_STARTED_400 =
  'The session is not started: no engine is running for it (never started, stopped, or logged out). ' +
  'Start the session and retry.';

/**
 * `EngineNotReadyError` (409) on `POST /sessions/:sessionId/pairing-code`, where the generic wording
 * above points the caller at the wrong state: both engines accept a pairing request only while the
 * session is `qr_ready`, and a session that reads `ready` is already linked and answers `400`.
 *
 * `qr_ready` is necessary but not sufficient on Baileys, hence the closing-socket sentence: the guard
 * also tests `ws.isOpen`, and the status trails the transport because Baileys emits its close only
 * after `await ws.close()` resolves. Same shape as the reload window ENGINE_NOT_READY_409 names, and
 * for the same reason: a caller that treats the documented status as sufficient would otherwise read
 * a legitimate retryable 409 as a bad state.
 */
export const PAIRING_NOT_READY_409 =
  'The session is not waiting to be linked: the engine is still connecting, or reconnecting after a ' +
  'drop, so the request never reached WhatsApp. Wait for `status` to read `qr_ready` and retry. Once a ' +
  'code has been accepted the session moves through `authenticating` and `initializing` to `ready` and ' +
  'answers this until then; wait for `ready` in that case. A session that reads `ready` is already ' +
  'linked and answers `400` instead. One window answers this while the session still reads ' +
  '`qr_ready`: on the Baileys engine a socket that has begun closing stops accepting a pairing ' +
  'request before the status catches up, which on a silently dropped connection takes until the ' +
  "WebSocket's close timeout (30 s); retry, and the status follows shortly.";

/**
 * `EngineTransportError` (503) on `POST /sessions/:sessionId/pairing-code`, where the whatsapp-web.js
 * engine bounds each attempt and retries the navigation shapes: WhatsApp Web reloads its QR page every
 * few seconds while unpaired, so a request can land mid-navigation. Only an exhausted budget is
 * reported here, and an attempt can exhaust it on a bare timeout with no navigation behind it, so the
 * description says what the gateway knows rather than naming a cause. A refusal WhatsApp itself sends
 * is not navigation-shaped and propagates on the first attempt instead.
 */
export const PAIRING_TRANSPORT_503 =
  'The pairing code could not be generated: the gateway stopped waiting after its attempt budget, ' +
  'usually because WhatsApp Web kept reloading its QR page. The condition is transient and the ' +
  "request is worth retrying; the last attempt's reason is carried in the message. An attempt that " +
  'timed out may still have reached WhatsApp, and a retry starts the linking flow again, with the ' +
  'same risk of unlinking an already-linked device that this route carries generally. The Baileys ' +
  'engine does not answer this, having no page to reload.';

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
  'Baileys rejects a phone number reported as unregistered. ' +
  'The request was rejected before anything was sent. Among the causes: the recipient could not be ' +
  'addressed — WhatsApp reports no deliverable id for that `chatId`, which is how it says the number ' +
  'is not on WhatsApp — as well as body validation and a session that is not active.';

/** `EngineRefusedError` (403) — the request was well formed; WhatsApp itself refused it. */
export const ENGINE_REFUSED_403 =
  'WhatsApp refused the operation. The request was well formed — the refusal happened WhatsApp-side, ' +
  'most often because the account lacks the admin rights the operation requires.';

export const RECIPIENT_LOOKUP_503 =
  'Baileys could not complete the recipient lookup within the request budget. On send routes, ' +
  'no message was handed to WhatsApp for this lookup failure.';

/**
 * `EngineThrottledError` (429) and `EngineTransportError` (408), both 503, from `mapSendRefusal`: on Baileys a
 * send, reaction, delete, pin, edit or status post awaits several queries before it relays the message, and
 * WhatsApp turns a throttled or timed out one away with that code. They differ in what they prove: a throttle
 * sent nothing, so the idempotency key is freed; a timeout proves nothing, so the key stays taken. A connection
 * that closed before the message was written (`EngineNotSentError`) sent nothing either.
 */
const SEND_REFUSAL_503 =
  'On Baileys, also when WhatsApp rate-limits the request (code 429: nothing was sent, and a keyed send frees ' +
  'its `Idempotency-Key`), times out a query it awaits (code 408: the outcome is not proven, and a keyed ' +
  'send keeps its `Idempotency-Key` taken), or the connection closes before the message is written (nothing ' +
  'was sent, and a keyed send frees its `Idempotency-Key`).';

/**
 * Both texts, for every route that reaches the Baileys send path. `presence/subscribe` shares the recipient
 * lookup but sends nothing, so it keeps RECIPIENT_LOOKUP_503 alone.
 */
export const SEND_503 = `${RECIPIENT_LOOKUP_503} ${SEND_REFUSAL_503}`;

/**
 * The same refusals on a Baileys status post. It has no recipient to look up and takes no idempotency key,
 * so the text names the post only.
 */
export const STATUS_POST_503 =
  'On Baileys, WhatsApp can answer the post with a 503: it rate-limited the request (code 429: nothing was ' +
  'posted) or timed out a query the post awaits (code 408: the outcome is not proven, so the post may have ' +
  'been published). The post also answers 503 when the connection closes before it is written (nothing was ' +
  'posted).';

/** `MessageNotFoundError` (404): outside the adapter's lookup window, or revoked. */
export const MESSAGE_NOT_FOUND_404 =
  "No such message: the id is outside the engine's lookup window (roughly the last hundred messages " +
  'of the chat, or absent from the Baileys store) or the message was revoked.';

/**
 * `MessageNotFoundError` (404) on the send routes that take a `quotedMessageId`. Not the react/delete
 * wording: whatsapp-web.js looks the quote up by id in the page's message collection and then by
 * `Msg.getMessagesById`, with no window of recent messages, and does not refuse a quote that resolves
 * but cannot be replied to.
 */
export const QUOTED_MESSAGE_NOT_FOUND_404 =
  'The `quotedMessageId` could not be resolved: the whatsapp-web.js page does not hold it, or the ' +
  'Baileys store does not (it was never received or sent by this session, or it was evicted or deleted). ' +
  'On whatsapp-web.js a message that resolves but cannot be replied to is sent without the quote.';

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

/**
 * send-text's 413: a custom preview's image has its own cap, `LINK_PREVIEW_THUMBNAIL_MAX_BYTES`, far
 * below the 50 MiB media cap that MEDIA_TOO_LARGE_413 names.
 */
export const PREVIEW_IMAGE_TOO_LARGE_413 =
  'The `customLinkPreview` image, as decoded `thumbnailBase64` or as downloaded from `thumbnailUrl`, ' +
  'exceeds 5 MiB (or `MEDIA_DOWNLOAD_MAX_BYTES`, if that is lower).';

/** MEDIA_URL_PROXY_503 for send-text, whose only fetched URL is a custom preview's `thumbnailUrl`. */
export const PREVIEW_IMAGE_PROXY_503 =
  'The session routes its URL fetches through an egress proxy, and the `customLinkPreview.thumbnailUrl` ' +
  'fetch failed or timed out before any response arrived, so nothing was sent. The proxy or the target ' +
  'behind it may be at fault; the gateway cannot tell which. Without a session proxy the same failure ' +
  'answers `400`.';

/**
 * `GroupNotFoundError` (404) — the id names a group, but no such group is known.
 *
 * It does NOT cover an id that addresses a 1:1 chat: every route carrying this response guards the
 * id shape first and answers 400, so advertising the 1:1 case here would contradict the 400 on the
 * same route. Keep the two descriptions disjoint — a caller uses them to tell "wrong kind of id"
 * (fix the request) apart from "right kind, no such group" (the group is gone or was never joined).
 */
export const GROUP_NOT_FOUND_404 = 'No such group — the id is unknown.';

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

/**
 * `PayloadTooLargeException` (413), thrown by `assertBase64WithinMediaCap` when an outbound base64
 * payload's DECODED size exceeds the shared media byte cap, before the payload is persisted or handed
 * to an engine.
 *
 * Declared as a constant for the same reason as the rest of this file: the cap belongs to the media
 * path, not to any one route, and it already reaches nine call sites. It was answered by every media
 * send long before it was declared on any of them, which is how a caller reading only the contract
 * came to expect a `400` the code never sends.
 */
export const MEDIA_TOO_LARGE_413 =
  'The decoded base64 media, or the media downloaded from `url`, exceeds the media byte cap ' +
  '(`MEDIA_DOWNLOAD_MAX_BYTES`, 50 MiB by default). A whole request is separately bounded by `BODY_SIZE_LIMIT` (25 mb by default), and ' +
  'base64 inflates by about a third, so a large send usually meets that coarser limit first: the ' +
  'body parser rejects the request before this check runs.';

/**
 * send-bulk's 413: only the base64 of an item is checked while the request is open. A `url` item is
 * fetched after the 202, and one over the cap fails that item in the batch results instead.
 */
export const BULK_MEDIA_TOO_LARGE_413 =
  "An item's decoded base64 media exceeds the media byte cap (`MEDIA_DOWNLOAD_MAX_BYTES`, 50 MiB by " +
  'default). A `url` item is fetched after the `202`; one over the cap fails that item in the batch ' +
  'results (`GET /messages/batch/{batchId}`) instead. The whole request is separately bounded by ' +
  '`BODY_SIZE_LIMIT` (25 mb by default).';

/**
 * `ServiceUnavailableException` (503), thrown by `loadRemoteMediaBuffer` when a `url` fetched through
 * the session's egress proxy fails before any response arrives. undici cannot tell a dead proxy from
 * an unreachable target there, so the text names both rather than blaming either one.
 */
export const MEDIA_URL_PROXY_503 =
  'The session routes its `url` fetches through an egress proxy, and the fetch failed or timed out ' +
  'before any response arrived, so the request was not carried out. The proxy or the target behind it ' +
  'may be at fault; the gateway cannot tell which. Retryable, but a `503` that persists while the proxy ' +
  'works points at the `url`. Without a session proxy the same failure answers `400`.';
