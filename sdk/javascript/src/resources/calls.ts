/**
 * Calls resource — incoming-call handling.
 *
 * Backed by `src/modules/call/call.controller.ts` (`@Controller('sessions/:sessionId/calls')`).
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { SuccessResult } from '../types.js';

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
}
