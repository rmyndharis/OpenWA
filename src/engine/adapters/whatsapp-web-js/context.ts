import { Client } from 'whatsapp-web.js';
import { createLogger } from '../../../common/services/logger.service';

export type AdapterLogger = ReturnType<typeof createLogger>;

/**
 * Shared context handed to each concern-scoped sub-adapter (Tier 3 #9).
 *
 * Sub-adapters never own the whatsapp-web.js Client directly — the main
 * WhatsAppWebJsAdapter owns lifecycle (connect/disconnect) and exposes the
 * live client through requireClient(), which enforces the READY gate exactly
 * as the original inline `ensureReady(); this.client!` did.
 */
export interface AdapterContext {
  /**
   * Returns the active client, or throws `WhatsApp client is not ready` when
   * the engine is not in READY state. Read live on every call so it reflects
   * connect/disconnect transitions.
   */
  requireClient(): Client;
  /** Shared logger so all sub-adapters log under the same source. */
  readonly logger: AdapterLogger;
}
