import { type Client, type Message } from 'whatsapp-web.js';
import {
  type EngineEventCallbacks,
  type InboundTicket,
  type IncomingMessage,
} from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { PAGE_RELOADING_MESSAGE, isNavigationError, toCapturedPageError } from './wwebjs-lifecycle';

/**
 * Shared host surface for the delegates extracted from WhatsAppWebJsAdapter (./wwebjs-groups,
 * ./wwebjs-messaging, ./wwebjs-contacts, …). The adapter keeps the public methods as thin
 * forwarders and builds ONE object literal of these closures, handed to every delegate, so a
 * delegate never touches lifecycle state directly. `config` is exposed for the send-id resolution
 * path, which persists learned phone -> lid pairs (lidMappingStore) under this session's id.
 */
export interface WwebjsEngineHost {
  ensureReady(): void;
  /** The live client; throws EngineNotReadyError when the session is no longer ready or the client is gone. */
  getClient(): Client;
  readonly logger: ReturnType<typeof createLogger>;
  isPageTransportError(error: unknown): boolean;
  reportIfPageTransportError(error: unknown, context: string): void;
  /**
   * For a best-effort read that carries on after a failure: reports a death only once puppeteer's page or
   * browser reads gone (it is given a moment to), never on the error's text alone. Optional so a host built
   * without it keeps the text-free behaviour of simply carrying on.
   */
  reportOnceGone?(error: unknown, context: string): Promise<void>;
  ensureNotChannelRecipient(chatId: string): void;
  getNumberId(number: string): Promise<string | null>;
  capInboundMediaFor(
    msg: Message,
    maxBytesOverride?: number,
    ticket?: InboundTicket,
  ): Promise<IncomingMessage['media'] | undefined>;
  readonly config: WhatsAppWebJsConfig;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
}

/**
 * The client of a send or status path, read after ensureReady() and any awaits since (a recipient lookup, a
 * media fetch). The adapter's getClient already refuses a session that is not ready; this keeps a host that
 * still has no client from handing the send a null typed as a Client, which would die as a TypeError 500 and
 * count toward the send breaker.
 */
export function requireClient(host: WwebjsEngineHost): Client {
  const client = host.getClient() as Client | null | undefined;
  if (!client) throw new EngineNotReadyError();
  return client;
}

/**
 * Answer the retryable 409 the adapter gives inside the navigation window when the error says the page
 * navigated under the call, and return for any other error. A call already in flight when WhatsApp Web
 * reloads dies with Puppeteer's navigation error before the window is stamped, so it would otherwise be a
 * bare 500, or, where a catch folds a failed lookup into "not found", a 404 for a group, contact or label
 * that exists. A navigation is not a death: nothing is reported.
 */
export function rethrowIfNavigation(host: WwebjsEngineHost, error: unknown): void {
  // A page the host already reads as dead is reported as dead, whatever the message says.
  if (isNavigationError(error) && !host.isPageTransportError(error))
    throw new EngineNotReadyError(PAGE_RELOADING_MESSAGE);
}

/**
 * Run a client operation, classifying a dead page/transport as the documented 503 plus an early
 * death signal instead of an opaque 500 under a status that still says READY - the split every
 * chats read already makes (#1081), and a page that navigated under the call as the 409 of
 * {@link rethrowIfNavigation}. Other errors propagate unchanged.
 *
 * Lives here rather than per delegate: ./wwebjs-channels, ./wwebjs-profile and ./wwebjs-status each
 * held a byte-identical private copy, and ./wwebjs-contacts needed a fourth.
 */
export async function withPage<T>(host: WwebjsEngineHost, context: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    rethrowIfNavigation(host, error);
    if (host.isPageTransportError(error)) {
      host.reportIfPageTransportError(error, context);
      throw new EngineTransportError(`Transport died during ${context}`);
    }
    throw error;
  }
}

/**
 * The NON-IDEMPOTENT counterpart of {@link withPage}: report a dead page as the same early death
 * signal, then rethrow the error with the caller's status unchanged (a failure WhatsApp Web threw in
 * the page keeps its 500 and only gains its reason, see toCapturedPageError).
 *
 * whatsapp-web.js can throw AFTER the request is already on the wire (see `sendResolved` in
 * ./wwebjs-messaging, which reports and rethrows for exactly this reason), so a transport failure
 * here does NOT prove the status was not posted or the channel not created. `503` is the one status
 * the clients read as proof the gateway declined before acting, and the Go client replays a POST on
 * it, so answering it would have a retrying caller publish the status twice.
 *
 * ./baileys-channels leaves `createChannel` unbounded on the same reasoning, and the message sends
 * keep their `500` rather than a replayable `503`. Use {@link withPage} for reads and for
 * operations that converge when repeated, including DELETE.
 */
export async function reportPageDeath<T>(host: WwebjsEngineHost, context: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    host.reportIfPageTransportError(error, context);
    // A status post runs the same patched Client.sendMessage as a message send, so a failure WhatsApp
    // Web threw in the page reaches the caller with its reason. A no-op for every other error.
    const mapped = toCapturedPageError(error);
    if (mapped !== error) {
      // The mapped error is an HttpException, which Nest does not log, and a status post's own log line
      // (StatusService.recordedPost) carries only the session and kind: this is the line that keeps the
      // full in-page summary.
      host.logger.warn(`WhatsApp Web threw during ${context}`, {
        sessionId: host.config.sessionId,
        cause: (error as Error).message,
      });
    }
    throw mapped;
  }
}
