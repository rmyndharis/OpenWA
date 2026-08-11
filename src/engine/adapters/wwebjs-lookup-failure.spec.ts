import type { Client } from 'whatsapp-web.js';
import { WwebjsContacts } from './wwebjs-contacts';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * A failed lookup must not be reported as a negative result.
 *
 * `Client.getProfilePicUrl` (Client.js:2156-2170) runs in the page and catches
 * `ServerStatusCodeError` **itself**, resolving `undefined` — that is the entire "no picture, or
 * hidden by privacy" verdict. Every other error is rethrown. So on this engine the legitimate
 * negative never arrives as a throw, and a `catch → return null` can only ever turn a genuine
 * failure into "this contact has no avatar", answered `200` with `{"url": null}`.
 *
 * That is the inverse of Baileys, where a no-picture verdict *does* arrive as a throw and swallowing
 * it is correct — which is why the two adapters deliberately do not share a shape here.
 *
 * `getContactById` is a different case and is left alone: `window.WWebJS.getContact` has no
 * try/catch and reads `contact.isBusiness` straight off `Contact.find`, so an unknown contact throws
 * a TypeError on null. There a throw genuinely can mean not-found, and folding it to `null` (→ 404)
 * is defensible. What it lacks entirely, unlike its siblings, is the transport branch: a dead page
 * during a contact lookup currently reads as a clean 404.
 */

const logger = createLogger('wwebjs-lookup-failure.spec');

const PAGE_TRANSPORT_ERROR_PATTERN =
  /protocol error|target closed|targetclosederror|detached frame|session closed|connection closed/i;

function makeContacts(client: Partial<Record<string, jest.Mock>>): {
  contacts: WwebjsContacts;
  reported: string[];
} {
  const reported: string[] = [];
  const isPageTransportError = (error: unknown): boolean =>
    PAGE_TRANSPORT_ERROR_PATTERN.test(error instanceof Error ? error.message : String(error));
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    isPageTransportError,
    reportIfPageTransportError: (error: unknown, context: string) => {
      if (isPageTransportError(error)) reported.push(context);
    },
  } as unknown as WwebjsEngineHost;
  return { contacts: new WwebjsContacts(host), reported };
}

describe('WwebjsContacts.getProfilePicture', () => {
  it('reports no avatar only when the library resolves undefined, which is its ServerStatusCodeError verdict', async () => {
    const getProfilePicUrl = jest.fn().mockResolvedValue(undefined);
    await expect(makeContacts({ getProfilePicUrl }).contacts.getProfilePicture('628@c.us')).resolves.toBeNull();
  });

  it('returns the url when there is one', async () => {
    const getProfilePicUrl = jest.fn().mockResolvedValue('https://example.com/a.jpg');
    await expect(makeContacts({ getProfilePicUrl }).contacts.getProfilePicture('628@c.us')).resolves.toBe(
      'https://example.com/a.jpg',
    );
  });

  // The defect: a page-side exception carries no transport signature, so it used to fall through to
  // `return null` and reach the caller as "this contact has no avatar" with a 200.
  it('surfaces a page-side exception as a failure instead of reporting "no avatar"', async () => {
    const getProfilePicUrl = jest.fn().mockRejectedValue(new Error('t: t'));
    await expect(makeContacts({ getProfilePicUrl }).contacts.getProfilePicture('628@c.us')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('still surfaces a dead page, and still reports it as a death signal', async () => {
    const getProfilePicUrl = jest.fn().mockRejectedValue(new Error('Protocol error: Target closed'));
    const { contacts, reported } = makeContacts({ getProfilePicUrl });
    await expect(contacts.getProfilePicture('628@c.us')).rejects.toBeInstanceOf(EngineTransportError);
    expect(reported).toContain('getProfilePicture');
  });

  it('names the contact in the failure, so an operator can tell which lookup died', async () => {
    const getProfilePicUrl = jest.fn().mockRejectedValue(new Error('t: t'));
    await expect(makeContacts({ getProfilePicUrl }).contacts.getProfilePicture('628999@c.us')).rejects.toThrow(
      /628999/,
    );
  });
});

describe('WwebjsContacts.getContactById', () => {
  // Not-found semantics are preserved: on this path a throw genuinely can mean the contact is absent.
  it('still answers null for a non-transport error, since an unknown contact throws here', async () => {
    const getContactById = jest
      .fn()
      .mockRejectedValue(new TypeError("Cannot read properties of null (reading 'isBusiness')"));
    await expect(makeContacts({ getContactById }).contacts.getContactById('628@c.us')).resolves.toBeNull();
  });

  it('surfaces a dead page rather than reporting the contact as not found', async () => {
    const getContactById = jest.fn().mockRejectedValue(new Error('Session closed'));
    const { contacts, reported } = makeContacts({ getContactById });
    await expect(contacts.getContactById('628@c.us')).rejects.toBeInstanceOf(EngineTransportError);
    expect(reported).toContain('getContactById');
  });
});
