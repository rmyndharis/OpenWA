import { type Client, type Message } from 'whatsapp-web.js';
import { type EngineEventCallbacks, type IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';

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
