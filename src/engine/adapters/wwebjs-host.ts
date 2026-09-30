import { type Client, type Message } from 'whatsapp-web.js';
import { type EngineEventCallbacks, type IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { toCapturedPageError } from './wwebjs-lifecycle';

/**
 * Shared host surface for the delegates extracted from WhatsAppWebJsAdapter (./wwebjs-groups,
 * ./wwebjs-messaging, ./wwebjs-contacts, …). The adapter keeps the public methods as thin
 * forwarders and builds ONE object literal of these closures, handed to every delegate, so a
 * delegate never touches lifecycle state directly. `config` is exposed for the send-id resolution
 * path, which persists learned phone -> lid pairs (lidMappingStore) under this session's id.
 */
export interface WwebjsEngineHost {
  ensureReady(): void;
  getClient(): Client;
  readonly logger: ReturnType<typeof createLogger>;
  isPageTransportError(error: unknown): boolean;
  reportIfPageTransportError(error: unknown, context: string): void;
  ensureNotChannelRecipient(chatId: string): void;
  getNumberId(number: string): Promise<string | null>;
  capInboundMediaFor(msg: Message, maxBytesOverride?: number): Promise<IncomingMessage['media'] | undefined>;
  readonly config: WhatsAppWebJsConfig;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
  /** Own account wid, or undefined while no client exists (late events during teardown). */
  getSelfWid(): string | undefined;
}

/**
 * Run a client operation, classifying a dead page/transport as the documented 503 plus an early
 * death signal instead of an opaque 500 under a status that still says READY - the split every
 * chats read already makes (#1081). Other errors propagate unchanged.
 *
 * Lives here rather than per delegate: ./wwebjs-channels, ./wwebjs-profile and ./wwebjs-status each
 * held a byte-identical private copy, and ./wwebjs-contacts needed a fourth.
 */
export async function withPage<T>(host: WwebjsEngineHost, context: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
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
      // The mapped error is an HttpException, which Nest does not log, and the status path logs
      // nothing of its own: this is the one line that keeps the full in-page summary.
      host.logger.warn(`WhatsApp Web threw during ${context}`, {
        sessionId: host.config.sessionId,
        cause: (error as Error).message,
      });
    }
    throw mapped;
  }
}
