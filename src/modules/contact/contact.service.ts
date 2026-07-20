import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { paginate, ListOptions } from '../../common/utils/paginate';

/**
 * Owns engine access for contact operations so the "session not started" guard and
 * contact business rules (not-found mapping) live behind the service boundary.
 */
@Injectable()
export class ContactService {
  constructor(private readonly sessionService: SessionService) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

  getContacts(sessionId: string, opts: ListOptions = {}) {
    // getEngine throws synchronously (keeps the "session not started" guard a sync 400); the
    // engine returns the full set and we bound the HTTP response window via paginate().
    return this.getEngine(sessionId)
      .getContacts()
      .then(contacts => paginate(contacts, opts.limit, opts.offset));
  }

  async getContactById(sessionId: string, contactId: string) {
    const contact = await this.getEngine(sessionId).getContactById(contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }
    return contact;
  }

  checkNumberExists(sessionId: string, number: string) {
    return this.getEngine(sessionId).checkNumberExists(number);
  }

  getNumberId(sessionId: string, number: string) {
    return this.getEngine(sessionId).getNumberId(number);
  }

  resolveContactPhone(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).resolveContactPhone(contactId);
  }

  getProfilePicture(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).getProfilePicture(contactId);
  }

  /** Upper bound for one batch call — keeps a huge `ids` list from pinning the engine for minutes. */
  private static readonly PROFILE_PICTURES_MAX_IDS = 50;

  /** Per-id engine-lookup deadline: one hanging id must not hold the whole batch hostage. */
  private static readonly PROFILE_PICTURE_LOOKUP_TIMEOUT_MS = 8000;

  /**
   * Batch-resolve profile picture URLs for a list of contact ids (the dashboard's chat-list avatars
   * — one HTTP call instead of N, so the per-IP throttle isn't exhausted by a sidebar full of
   * parallel fetches). Engine lookups run 5 at a time with a per-id deadline; a per-id failure or
   * timeout yields null for that id (hidden/no picture), never aborts the batch. Ids beyond
   * PROFILE_PICTURES_MAX_IDS are ignored.
   */
  async getProfilePictures(sessionId: string, ids: string[]): Promise<Record<string, string | null>> {
    const engine = this.getEngine(sessionId);
    const capped = ids.slice(0, ContactService.PROFILE_PICTURES_MAX_IDS);
    const pictures: Record<string, string | null> = {};
    const CHUNK = 5;
    for (let i = 0; i < capped.length; i += CHUNK) {
      const chunk = capped.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map((id): Promise<readonly [string, string | null]> => {
          // Per-id deadline: a hanging lookup (bad/unreachable id) resolves null instead of
          // stalling the whole batch; the timer is cleared the moment the engine settles.
          return new Promise<readonly [string, string | null]>(resolve => {
            const timer = setTimeout(
              () => resolve([id, null] as const),
              ContactService.PROFILE_PICTURE_LOOKUP_TIMEOUT_MS,
            );
            engine.getProfilePicture(id).then(
              url => {
                clearTimeout(timer);
                resolve([id, url] as const);
              },
              () => {
                clearTimeout(timer);
                resolve([id, null] as const);
              },
            );
          });
        }),
      );
      for (const [id, url] of results) {
        pictures[id] = url;
      }
    }
    return pictures;
  }

  blockContact(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).blockContact(contactId);
  }

  unblockContact(sessionId: string, contactId: string) {
    return this.getEngine(sessionId).unblockContact(contactId);
  }
}
