/**
 * Sessions resource — lifecycle management for WhatsApp sessions.
 *
 * Backed by `src/modules/session/session.controller.ts`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  CreateSessionRequest,
  PairingCodeResponse,
  QrCodeResponse,
  RequestPairingCodeRequest,
  SessionResponse,
  SessionStatsOverview,
} from '../types.js';

export class SessionsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all sessions (scoped to the API key's `allowedSessions`). */
  list(): Promise<SessionResponse[]> {
    return this.client.request<SessionResponse[]>({ method: 'GET', path: '/api/sessions' });
  }

  /** Get a single session by id. */
  get(id: string): Promise<SessionResponse> {
    return this.client.request<SessionResponse>({ method: 'GET', path: `/api/sessions/${encodeSegment(id)}` });
  }

  /** Create a new session. Requires an OPERATOR-level key. */
  create(body: CreateSessionRequest): Promise<SessionResponse> {
    return this.client.request<SessionResponse>({ method: 'POST', path: '/api/sessions', body });
  }

  /** Delete a session. Requires an OPERATOR-level key. */
  delete(id: string): Promise<void> {
    return this.client.request<void>({ method: 'DELETE', path: `/api/sessions/${encodeSegment(id)}` });
  }

  /** Start a session and initialize the WhatsApp connection. */
  start(id: string): Promise<SessionResponse> {
    return this.client.request<SessionResponse>({ method: 'POST', path: `/api/sessions/${encodeSegment(id)}/start` });
  }

  /** Stop a session and disconnect gracefully. */
  stop(id: string): Promise<SessionResponse> {
    return this.client.request<SessionResponse>({ method: 'POST', path: `/api/sessions/${encodeSegment(id)}/stop` });
  }

  /**
   * Attempt an engine-native unlink of this device, then stop the session. A `200` means the
   * unlink operation AND the required local credential cleanup completed — it is not an
   * independent observation that the handset UI no longer shows the linked device. Because a
   * completed unlink wipes the stored credentials, a later `start` requires a fresh QR scan or
   * pairing code. Requires a running session. Rejects with HTTP `502` and
   * `code: 'SESSION_LOGOUT_INCOMPLETE'` when the session was stopped locally but the logout
   * operation did not complete (no send, no acknowledgement, timeout/transport error, or local
   * cleanup failure); `phone` is cleared and no success audit is written. Start the session again
   * and retry the logout; do not assume the retry reconnects automatically or lands in a
   * guaranteed QR state.
   */
  logout(id: string): Promise<SessionResponse> {
    return this.client.request<SessionResponse>({ method: 'POST', path: `/api/sessions/${encodeSegment(id)}/logout` });
  }

  /** Force-kill a stuck session (SIGKILL + teardown). */
  forceKill(id: string): Promise<SessionResponse> {
    return this.client.request<SessionResponse>({ method: 'POST', path: `/api/sessions/${encodeSegment(id)}/force-kill` });
  }

  /** Get the current QR code for authentication (live from the engine, not the DB). */
  getQrCode(id: string): Promise<QrCodeResponse> {
    return this.client.request<QrCodeResponse>({ method: 'GET', path: `/api/sessions/${encodeSegment(id)}/qr` });
  }

  /** Request an 8-character pairing code for phone-based login. */
  requestPairingCode(id: string, body: RequestPairingCodeRequest): Promise<PairingCodeResponse> {
    return this.client.request<PairingCodeResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(id)}/pairing-code`,
      body,
    });
  }

  /** Aggregate statistics across the API key's sessions. */
  stats(): Promise<SessionStatsOverview> {
    return this.client.request<SessionStatsOverview>({
      method: 'GET',
      path: '/api/sessions/stats/overview',
    });
  }
}
