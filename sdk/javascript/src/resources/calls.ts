/**
 * Calls resource — incoming-call handling.
 *
 * Backed by `src/modules/call/call.controller.ts` (`@Controller('sessions/:sessionId/calls')`).
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { CallLinkResponse, CreateCallLinkRequest, SuccessResult } from '../types.js';

export class CallsResource {
  constructor(private readonly client: OpenWAClient) {}

  /**
   * Reject a ringing incoming call. The `callId` comes from the `call.received`
   * webhook/socket event; the server answers 404 when the call is not found or no
   * longer ringing. Requires an OPERATOR-level key.
   */
  rejectCall(sessionId: string, callId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/calls/${encodeSegment(callId)}/reject`,
    });
  }

  /**
   * Create a shareable WhatsApp call link.
   *
   * Both fields are required. `startTime` is absolute epoch MILLISECONDS — a link for right now is
   * `Date.now()` rather than an omitted field, because whatsapp-web.js generates an event-linked
   * call and has no notion of "no start time". A WhatsApp-side failure answers `403` rather than a
   * success carrying an empty link.
   */
  createLink(sessionId: string, body: CreateCallLinkRequest): Promise<CallLinkResponse> {
    return this.client.request<CallLinkResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/calls/link`,
      body,
    });
  }
}
