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
  SessionConfig,
  SessionResponse,
  UpdateSessionConfigRequest,
  SessionStatsOverview,
  SetOwnPresenceRequest,
  SuccessResult,
} from '../types.js';

/** Pagination for {@link SessionsResource.list}. The server applies its own default when omitted. */
export interface ListSessionsQuery {
  limit?: number;
  offset?: number;
}

export class SessionsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all sessions (scoped to the API key's `allowedSessions`). */
  list(query?: ListSessionsQuery): Promise<SessionResponse[]> {
    return this.client.request<SessionResponse[]>({ method: 'GET', path: '/api/sessions', query });
  }

  /** Read a session's effective configuration. */
  getConfig(id: string): Promise<SessionConfig> {
    return this.client.request<SessionConfig>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(id)}/config`,
    });
  }

  /**
   * Update a running session's configuration. Takes effect without re-linking the account — all three
   * fields were fixed at creation before this route existed.
   */
  updateConfig(id: string, body: UpdateSessionConfigRequest): Promise<SessionConfig> {
    return this.client.request<SessionConfig>({
      method: 'PATCH',
      path: `/api/sessions/${encodeSegment(id)}/config`,
      body,
    });
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
    return this.client.request<SessionResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(id)}/force-kill`,
    });
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

  /**
   * Set the account's own global presence — appear online, or offline.
   *
   * `available: false` hands notifications back to the phone: a linked device that stays online
   * suppresses the phone's own alerts. This is the ACCOUNT's presence, not a chat's — see
   * {@link ChatsResource.sendState} for per-chat typing/recording.
   */
  setOnlinePresence(sessionId: string, body: SetOwnPresenceRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/presence`,
      body,
    });
  }
}
