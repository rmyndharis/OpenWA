/**
 * Profile resource — the session's own account profile (name, about/status, picture).
 *
 * Backed by `src/modules/profile/profile.controller.ts` (`@Controller('sessions/:sessionId/profile')`).
 * All operations require an OPERATOR-level key.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { SetProfilePictureRequest, SuccessResult } from '../types.js';

export class ProfileResource {
  constructor(private readonly client: OpenWAClient) {}

  /** Set the account display name (max 25 chars). */
  setProfileName(sessionId: string, name: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/profile/name`,
      body: { name },
    });
  }

  /** Set the account about/status text (max 139 chars; empty string clears it). */
  setProfileStatus(sessionId: string, status: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/profile/status`,
      body: { status },
    });
  }

  /** Set the account profile picture (provide `url` OR `base64` + `mimetype`). */
  setProfilePicture(sessionId: string, body: SetProfilePictureRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/profile/picture`,
      body,
    });
  }
}
