import { type Client } from 'whatsapp-web.js';
import { Contact } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { userPart } from '../identity/wa-id';
import { readWid, type SerializedWid } from '../types/whatsapp-web-js.types';
import { type WwebjsEngineHost, withPage } from './wwebjs-host';

/** The raw whatsapp-web.js contact element type, kept local so the wwebjs `Contact` type never leaks. */
type RawWwebjsContact = Awaited<ReturnType<Client['getContacts']>>[number];

/** The six fields {@link WwebjsContacts.toContact} reads, projected in-page by {@link readLeanContacts}. */
interface LeanContact {
  id: SerializedWid | string;
  name?: string;
  pushname?: string;
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
}

/**
 * Read the contact list IN-PAGE, projected to only the fields {@link WwebjsContacts.toContact} keeps,
 * yielding to the page event loop every 256 contacts so the liveness probe's queued `getState()`
 * evaluate can interleave (#1501). whatsapp-web.js's own `client.getContacts()` maps the same
 * `window.WWebJS.getContactModel`, but over a `Promise.all` with no await for personal contacts, so it
 * runs as one uninterrupted synchronous stretch that starves the probe on a large address book and
 * makes the watchdog tear a healthy session down mid-read. The per-contact `serialize()` cost is
 * unchanged; the yield is what makes the read probe-safe regardless of size.
 *
 * Reusing `getContactModel` keeps `id`/`number`/`name`/`pushname`/`isMyContact`/`isBlocked` byte
 * identical to `getContacts()` (`Contact.number` is `data.userid`), and the raw `id` stays readable by
 * {@link readWid} (`_serialized`, the post-rename `$1`, or a lid `phoneNumber` string all resolve).
 * `BusinessProfile.find` is skipped: its only output, `res.businessProfile`, is not one of the six
 * fields, so dropping it costs nothing and saves a network fetch per business contact.
 */
export async function readLeanContacts(): Promise<LeanContact[]> {
  const w = window as unknown as {
    require: (m: string) => { Contact: { getModelsArray: () => unknown[] } };
    WWebJS: {
      getContactModel: (contact: unknown) => {
        id: SerializedWid | string;
        name?: string;
        pushname?: string;
        userid: string;
        isMyContact: boolean;
        isBlocked: boolean;
      };
    };
  };
  const models = w.require('WAWebCollections').Contact.getModelsArray();
  const out: LeanContact[] = [];
  for (let i = 0; i < models.length; i++) {
    const m = w.WWebJS.getContactModel(models[i]);
    out.push({
      id: m.id,
      name: m.name,
      pushname: m.pushname,
      number: m.userid,
      isMyContact: m.isMyContact,
      isBlocked: m.isBlocked,
    });
    // Yield every 256 contacts so the getState() liveness probe can interleave (#1501);
    // raise the stride if the read ever gets too chatty on a very large address book.
    if ((i & 0xff) === 0xff) await new Promise(resolve => setTimeout(resolve));
  }
  return out;
}

/**
 * Contact operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly.
 */
export class WwebjsContacts {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  /**
   * Map a raw whatsapp-web.js contact to the library-agnostic {@link Contact}. The id is read
   * through {@link readWid} so both the `_serialized` and post-rename `$1` shapes resolve; a
   * contact with no readable id returns null so callers can skip it instead of dereferencing
   * unguarded (the shape that lets a single bad entry reject the whole request).
   */
  private toContact(c: RawWwebjsContact): Contact | null {
    const id = readWid(c.id);
    if (!id) return null;
    return {
      id,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.host.ensureReady();

    let raw: RawWwebjsContact[];
    try {
      // A direct in-page walk that yields so the liveness probe is not starved (see readLeanContacts,
      // #1501), instead of whatsapp-web.js's atomic client.getContacts(). The projected rows are a
      // strict subset of a Contact; the mapping below reads only those six fields.
      const page = (this.client() as unknown as { pupPage?: { evaluate: <T>(fn: () => Promise<T>) => Promise<T> } })
        .pupPage;
      raw = ((await page?.evaluate(readLeanContacts)) ?? []) as unknown as RawWwebjsContact[];
    } catch (error) {
      // A dead page surfaces here as a raw Puppeteer error; convert it to the documented transport
      // failure the way wwebjs-chats.ts does, so a transport death answers 503 instead of a bare 500.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getContacts');
        throw new EngineTransportError('Transport died while reading contacts');
      }
      throw error;
    }

    // Read every id through readWid (so the `_serialized`->`$1` rename lands here too) and skip
    // entries with no readable id, counted and logged like the chats path, rather than dropping
    // the whole address book silently.
    const contacts: Contact[] = [];
    let skipped = 0;
    for (const c of raw) {
      const mapped = this.toContact(c);
      if (!mapped) {
        skipped++;
        continue;
      }
      contacts.push(mapped);
    }
    if (skipped > 0) {
      this.host.logger.warn(`Skipped ${skipped} contact(s) without a serialized id`);
    }
    return contacts;
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.host.ensureReady();
    try {
      const contact = await this.client().getContactById(contactId);
      return this.toContact(contact);
    } catch (error) {
      // Unlike the avatar lookup, a throw here can legitimately mean the contact is absent:
      // `window.WWebJS.getContact` has no try/catch and reads `contact.isBusiness` straight off
      // `Contact.find`, so an unknown id throws a TypeError on null. Null (→ 404) stays the answer
      // for that. A dead page is not a missing contact, though, and this was the one lookup that
      // never separated the two.
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getContactById');
        throw new EngineTransportError(`Transport died while reading contact ${contactId}`);
      }
      this.host.logger.warn(`Failed to get contact: ${contactId}`, { error: String(error) });
      return null;
    }
  }

  async getNumberId(number: string): Promise<string | null> {
    this.host.ensureReady();
    const numberId = await withPage(this.host, 'getNumberId', () => this.client().getNumberId(number));
    // Read both property names: a WA Web build that renamed `_serialized` would otherwise make
    // every number look unregistered — and checkNumberExists below reports exactly that.
    return readWid(numberId) ?? null;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    // Queried one id at a time: the batch form is prone to "Evaluation failed" and rate-limiting
    // (whatsapp-web.js #3857/#3969). `pn` is the phone JID (`<digits>@c.us`) when the account knows
    // the mapping. An empty/absent pn RESOLVES to null (a definitive "no mapping" answer); a thrown
    // error PROPAGATES - the lid resolver must not mistake a transient failure (dead page,
    // evaluation error, rate limit) for "this contact has no phone" and clobber a valid stored
    // mapping with it. The HTTP route that promises null-on-failure swallows at its boundary
    // (contact.service.resolveContactPhone).
    const [result] = await this.client().getContactLidAndPhone([contactId]);
    const pn = result?.pn;
    return pn ? pn.replace(/@c\.us$/i, '').replace(/\D/g, '') || null : null;
  }

  async upsertContact(contactId: string, firstName: string, lastName = ''): Promise<void> {
    this.host.ensureReady();
    // wwjs addresses the addressbook entry by PHONE NUMBER, not JID (Client.js:3266). lastName is
    // positional and required there, so an absent one is passed as an empty string rather than
    // undefined, which would land in the page-side payload as the literal string "undefined".
    // syncToAddressbook is left at its default (false): writing to the device addressbook is a
    // heavier, separately-consented action than saving the WhatsApp contact.
    await withPage(this.host, 'upsertContact', () =>
      this.client().saveOrEditAddressbookContact(userPart(contactId), firstName, lastName),
    );
    this.host.logger.log(`Saved addressbook contact ${contactId}`);
  }

  async deleteContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await withPage(this.host, 'deleteContact', () => this.client().deleteAddressbookContact(userPart(contactId)));
    this.host.logger.log(`Deleted addressbook contact ${contactId}`);
  }

  async blockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await withPage(this.host, 'blockContact', async () => {
      const contact = await this.client().getContactById(contactId);
      await contact.block();
    });
    this.host.logger.log(`Blocked contact ${contactId}`);
  }

  /**
   * The read half of block/unblockContact. Ids only — the neutral common subset with Baileys,
   * whose blocklist query answers bare jids. An entry whose wid is unreadable (#747 rename
   * hazard) is dropped rather than reported as the literal "undefined".
   */
  async getBlockedContacts(): Promise<string[]> {
    this.host.ensureReady();
    const contacts = await withPage(this.host, 'getBlockedContacts', () => this.client().getBlockedContacts());
    return contacts.map(c => readWid(c.id as unknown as SerializedWid)).filter((id): id is string => Boolean(id));
  }

  async unblockContact(contactId: string): Promise<void> {
    this.host.ensureReady();
    await withPage(this.host, 'unblockContact', async () => {
      const contact = await this.client().getContactById(contactId);
      await contact.unblock();
    });
    this.host.logger.log(`Unblocked contact ${contactId}`);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.host.ensureReady();
    try {
      const url = await this.client().getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      // Nothing reaching here is a statement about the avatar, so nothing reaching here may become
      // null. Returning null would answer 200 with {"url": null} — byte-identical to the verdict
      // above — and a caller that caches "no avatar" would record absence for a lookup that never
      // produced one. The page throws for two distinct reasons and we cannot tell them apart from
      // the message: `getChat` failing to resolve the contact at all, or the profile-pic bridge
      // failing. 404 would assert the first; 503 says only that we could not reach an answer, which
      // is all we know.
      //
      // NOTE the Baileys adapter does the OPPOSITE on this same interface method, and correctly:
      // there a no-picture verdict *is* delivered as a throw, so it swallows to null and uses its
      // own deadline to separate a verdict from a non-answer. Do not harmonise the two into a shared
      // helper — the engines disagree about what a throw means.
      this.host.reportIfPageTransportError(error, 'getProfilePicture');
      this.host.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      throw new EngineTransportError(`Could not read the profile picture for ${contactId}: ${String(error)}`);
    }
  }
}
