/**
 * Contacts resource — contact lookup and management.
 *
 * Backed by `src/modules/contact/contact.controller.ts`.
 * @packageDocumentation
 */

import type { OpenWAClient } from '../client.js';
import type {
  CheckNumberResponse,
  ContactPhoneResponse,
  ContactRecord,
  ProfilePictureResponse,
  SuccessResult,
} from '../types.js';

export interface ListContactsQuery {
  limit?: number;
  offset?: number;
}

export class ContactsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List contacts known to the session. */
  list(sessionId: string, query?: ListContactsQuery): Promise<ContactRecord[]> {
    return this.client.request<ContactRecord[]>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/contacts`,
      query,
    });
  }

  /** Get details for a single contact by id (JID). */
  get(sessionId: string, contactId: string): Promise<ContactRecord> {
    return this.client.request<ContactRecord>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/contacts/${contactId}`,
    });
  }

  /** Check whether a phone number is registered on WhatsApp. */
  check(sessionId: string, number: string): Promise<CheckNumberResponse> {
    return this.client.request<CheckNumberResponse>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/contacts/check/${number}`,
    });
  }

  /** Get the contact's profile picture URL (or null). */
  profilePicture(sessionId: string, contactId: string): Promise<ProfilePictureResponse> {
    return this.client.request<ProfilePictureResponse>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/contacts/${contactId}/profile-picture`,
    });
  }

  /** Resolve a contact id (e.g. a `@lid`) to a phone number. */
  phone(sessionId: string, contactId: string): Promise<ContactPhoneResponse> {
    return this.client.request<ContactPhoneResponse>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/contacts/${contactId}/phone`,
    });
  }

  /** Block a contact. Requires an OPERATOR-level key. */
  block(sessionId: string, contactId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${sessionId}/contacts/${contactId}/block`,
    });
  }

  /** Unblock a contact. Requires an OPERATOR-level key. */
  unblock(sessionId: string, contactId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${sessionId}/contacts/${contactId}/block`,
    });
  }
}
