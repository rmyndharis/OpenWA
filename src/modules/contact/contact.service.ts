import { HttpException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { createLogger } from '../../common/services/logger.service';
import { Contact, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { paginate, ListOptions } from '../../common/utils/paginate';
import { ListingMemo } from '../../common/utils/listing-memo';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { isIndividualWid, parseWaId, toNeutralJid } from '../../engine/identity/wa-id';

/**
 * Owns engine access for contact operations so the "session not started" guard and
 * contact business rules (not-found mapping) live behind the service boundary.
 */
@Injectable()
export class ContactService {
  private readonly logger = createLogger('ContactService');
  /** The contact listing the pages of one walk share. Every addressbook or block write drops it. */
  private readonly listings = new ListingMemo<Contact>();

  constructor(private readonly engines: EngineRegistry) {
    engines.onRetire(id => this.listings.drop(id));
  }

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  /**
   * Every contact WITHOUT the response window, for callers that filter before paging. `offset` is the
   * window the caller is about to take: a later page reuses the list its walk's first page read.
   */
  listContacts(sessionId: string, offset?: number) {
    // getEngine throws synchronously (keeps the "session not started" guard a sync 400).
    const engine = this.getEngine(sessionId);
    return this.listings.read(sessionId, offset, () => engine.getContacts());
  }

  getContacts(sessionId: string, opts: ListOptions = {}) {
    // The engine returns the full set and we bound the HTTP response window via paginate().
    return this.listContacts(sessionId, opts.offset).then(contacts => paginate(contacts, opts.limit, opts.offset));
  }

  async getContactById(sessionId: string, contactId: string) {
    const contact = await this.getEngine(sessionId).getContactById(contactId);
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found`);
    }
    return contact;
  }

  /** The read half of block/unblock — neutral ids only (the honest common subset of both engines). */
  getBlockedContacts(sessionId: string) {
    return this.getEngine(sessionId).getBlockedContacts();
  }

  getNumberId(sessionId: string, number: string) {
    return this.getEngine(sessionId).getNumberId(number);
  }

  /**
   * The HTTP route promises null when the LOOKUP cannot produce an answer (docs/06 and the
   * ApiResponse text): a dead page, an evaluation error or a rate limit answers 200 null, not a
   * 5xx. The ENGINE method rejects on those (the lid resolver needs the distinction), so genuine
   * lookup failures are swallowed here at the boundary - logged at debug, since the old adapter
   * catch was the only place these were visible. Deliberate HTTP answers (400 not-started, 409
   * not-ready) propagate: nulling them would tell a retrying caller "no mapping" for a session
   * that simply is not running.
   */
  async resolveContactPhone(sessionId: string, contactId: string): Promise<string | null> {
    const engine = this.getEngine(sessionId);
    try {
      return await engine.resolveContactPhone(contactId);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.debug(`resolveContactPhone lookup failed for ${contactId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
   * parallel fetches). Engine lookups run 5 at a time with a per-id deadline. A timeout yields null
   * for that id and ends the walk: the ids of the later chunks are left out of the answer, like those
   * past the cap, so a caller asks for them again instead of reading null as "no picture", and
   * unfinished lookups never overlap new engine work. Ordinary per-id failures yield null and the
   * batch continues. EngineNotReadyError describes the session, not the id, so it fails the whole request with
   * 409 after the current chunk and the remaining chunks are not started. Answering 200 with every
   * avatar null would be cached by the dashboard as "no pictures". Ids beyond
   * PROFILE_PICTURES_MAX_IDS are ignored.
   */
  async getProfilePictures(sessionId: string, ids: string[]): Promise<Record<string, string | null>> {
    const engine = this.getEngine(sessionId);
    const capped = ids.slice(0, ContactService.PROFILE_PICTURES_MAX_IDS);
    const pictures: Record<string, string | null> = {};
    const CHUNK = 5;
    let notReady: EngineNotReadyError | undefined;
    for (let i = 0; i < capped.length; i += CHUNK) {
      const chunk = capped.slice(i, i + CHUNK);
      let timedOut = false;
      const results = await Promise.all(
        chunk.map((id): Promise<readonly [string, string | null]> => {
          // Per-id deadline: a hanging lookup (bad/unreachable id) resolves null instead of
          // stalling the whole batch; the timer is cleared the moment the engine settles.
          return new Promise<readonly [string, string | null]>(resolve => {
            const timer = setTimeout(() => {
              timedOut = true;
              resolve([id, null] as const);
            }, ContactService.PROFILE_PICTURE_LOOKUP_TIMEOUT_MS);
            engine.getProfilePicture(id).then(
              url => {
                clearTimeout(timer);
                resolve([id, url] as const);
              },
              (error: unknown) => {
                clearTimeout(timer);
                if (error instanceof EngineNotReadyError) notReady = error;
                resolve([id, null] as const);
              },
            );
          });
        }),
      );
      if (notReady) throw notReady;
      for (const [id, url] of results) {
        pictures[id] = url;
      }
      if (timedOut) break;
    }
    return pictures;
  }

  /**
   * Guarded because whatsapp-web.js's Contact.block()/unblock() silently return false for a group id
   * (nothing blocked, reported as success). Baileys' updateBlockStatus refuses an id it cannot map
   * between the phone and privacy-id dialects, which the adapter reports as 400
   * RecipientUnreachableError. See `assertBlockable` for why this guard is wider than the
   * addressbook one.
   */
  blockContact(sessionId: string, contactId: string) {
    this.assertBlockable(contactId);
    return this.getEngine(sessionId)
      .blockContact(this.toAddressableId(contactId))
      .finally(() => this.listings.drop(sessionId));
  }

  /**
   * Blocking acts on an IDENTITY, not on an addressbook row, so unlike the addressbook writes it
   * accepts a privacy id (`@lid`) as well as a phone-based one. It has to: a privacy-id contact has
   * no phone number, and the blocklist READ answers ids verbatim (Baileys maps each blocked jid
   * through `toNeutralJid`, which leaves an unresolved lid as `<lid>@lid`; whatsapp-web.js returns
   * the wid as-is), so refusing them made the very ids this API hands out unusable for the matching
   * write and left such a contact listed as blocked with no way to unblock it.
   *
   * whatsapp-web.js needs no phone here and only short-circuits (`Contact.block()` returns false
   * without acting) for a group. Baileys' `updateBlockStatus` maps the id first: blocking a lid
   * needs its phone mapping, and a phone-based id (block or unblock) needs its lid mapping; an
   * unmapped id answers 400 RecipientUnreachableError from the adapter. What must still be refused
   * up front is an id that names no individual at all, which is what made whatsapp-web.js answer
   * 200 "blocked" while nothing was blocked.
   */
  private assertBlockable(contactId: string): void {
    if (isIndividualWid(contactId) || this.isBareNumber(contactId)) return;
    throw new BadRequestException(
      `Contact ${contactId} does not name an individual; block and unblock act on a person, so pass a phone-based or privacy (@lid) contact id instead`,
    );
  }

  /**
   * An addressbook entry is keyed by a PHONE NUMBER, so a privacy-id (`@lid`) contact cannot be
   * saved or removed: the lid's digits are not a phone number, and whatsapp-web.js — which takes a
   * bare number rather than a JID — would happily store them as one, silently creating an
   * addressbook entry for a number that does not exist.
   *
   * Refused rather than forward-resolved through the lid mapping: the mapping is best-effort, and a
   * write that lands under the wrong number is worse than one the caller is told to redo with a
   * phone-based id.
   */
  private assertAddressable(contactId: string): void {
    const kind = parseWaId(contactId).kind;
    // Allow-list rather than deny-list: only a user id (or a bare number, which parses as
    // `unknown`) names a phone. A group/newsletter/broadcast/status id also carries digits that
    // whatsapp-web.js would happily store as a phone number for a contact that does not exist.
    // The DOMAIN alone is not enough: `parseWaId('NOT A USER@c.us').kind` is 'user', so free text
    // cleared this guard and reached the engine, which reported a successful save for an entry
    // keyed by something that is not a phone number. isIndividualWid additionally requires the
    // user-part to be numeric — the same predicate the group-participant, channel-admin and
    // message-mention surfaces already apply to these very shapes.
    if ((kind === 'user' && isIndividualWid(contactId)) || this.isBareNumber(contactId)) return;
    if (kind === 'lid') {
      throw new BadRequestException(
        `Contact ${contactId} is a privacy id (@lid) with no known phone number; the addressbook is keyed by phone number, so pass a phone-based contact id instead`,
      );
    }
    throw new BadRequestException(
      `Contact ${contactId} does not name a person; the addressbook is keyed by phone number, so pass a phone-based contact id instead`,
    );
  }

  /** A digits-only id, e.g. `628123456789` — accepted for convenience and qualified below. */
  private isBareNumber(contactId: string): boolean {
    return parseWaId(contactId).kind === 'unknown' && /^\d{5,}$/.test(contactId.trim());
  }

  /**
   * Qualify a bare number to the neutral `@c.us` dialect before it reaches an engine.
   *
   * Baileys keys the addressbook app-state patch by the id it is handed and only folds a recognised
   * user JID to the engine dialect, so an unqualified number would be written under a key WhatsApp
   * never reads — reported as success. whatsapp-web.js takes the user-part either way, so the
   * qualification is a no-op there.
   */
  private toAddressableId(contactId: string): string {
    const trimmed = contactId.trim();
    // Neutralized rather than passed through: a Meta-hosted id names the same account as its plain
    // twin but whatsapp-web.js knows no such domain, so forwarding the suffix verbatim would fail
    // inside the page instead of acting on the person. toNeutralJid is idempotent on ids already in
    // the neutral dialect, and the Baileys adapter re-encodes to its own dialect on the way out.
    return this.isBareNumber(trimmed) ? `${trimmed}@c.us` : toNeutralJid(trimmed);
  }

  upsertContact(sessionId: string, contactId: string, firstName: string, lastName?: string) {
    this.assertAddressable(contactId);
    // The DTO lets a JSON null through as "no last name". The engines default an omitted one to '' (a default
    // parameter ignores null), so null would otherwise reach the page-side save as a value.
    return this.getEngine(sessionId)
      .upsertContact(this.toAddressableId(contactId), firstName, lastName ?? undefined)
      .finally(() => this.listings.drop(sessionId));
  }

  deleteContact(sessionId: string, contactId: string) {
    this.assertAddressable(contactId);
    return this.getEngine(sessionId)
      .deleteContact(this.toAddressableId(contactId))
      .finally(() => this.listings.drop(sessionId));
  }

  unblockContact(sessionId: string, contactId: string) {
    this.assertBlockable(contactId);
    return this.getEngine(sessionId)
      .unblockContact(this.toAddressableId(contactId))
      .finally(() => this.listings.drop(sessionId));
  }
}
