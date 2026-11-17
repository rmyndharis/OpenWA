import type { Client } from 'whatsapp-web.js';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { WwebjsContacts } from './wwebjs-contacts';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * A block or unblock of a number the session never talked to asks WhatsApp for its privacy id first, and answers 400
 * only when WhatsApp gives none (docs/06: "a number the session never talked to can be blocked"). The text of that 400
 * therefore must not name a missing chat as the cause or tell the caller to message the number first: the lookup has
 * already asked WhatsApp. Two answers carry no id: `{}` (the exists query found no account) and `{ pn }` (the account
 * exists and WhatsApp gave no id for it), so the text must not claim either one alone.
 */
describe('the 400 of a block or unblock of a number WhatsApp gave no id for', () => {
  function wire(found: Array<{ lid?: string; pn?: string }>) {
    const client = {
      getContactLidAndPhone: jest.fn().mockResolvedValue(found),
      getContactById: jest.fn(),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger: { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    } as unknown as WwebjsEngineHost;
    return { contacts: new WwebjsContacts(host), client };
  }

  const CASES = [
    { op: 'block', run: (contacts: WwebjsContacts) => contacts.blockContact('628123@c.us') },
    { op: 'unblock', run: (contacts: WwebjsContacts) => contacts.unblockContact('628123@c.us') },
  ].flatMap(c => [
    { ...c, answer: 'an exists query that found no account', found: [{}] },
    { ...c, answer: 'an account WhatsApp gave no privacy id for', found: [{ pn: '628123@c.us' }] },
  ]);

  it.each(CASES)('$op does not suggest messaging the number first after $answer', async ({ run, found }) => {
    const { contacts, client } = wire(found);
    const refusal = await run(contacts).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(refusal).toBeInstanceOf(RecipientUnreachableError);
    expect(refusal).toMatchObject({ status: 400 });
    expect(refusal?.message).toContain('628123@c.us');
    expect(refusal?.message).not.toMatch(/message it once from the phone/i);
    expect(refusal?.message).not.toMatch(/no existing chat/i);
    // The refusal came before any contact was fetched or acted on.
    expect(client.getContactById).not.toHaveBeenCalled();
  });

  it('keeps the send-path text for a caller that gives no reason', () => {
    expect(new RecipientUnreachableError('628123@c.us').message).toMatch(/no existing chat/i);
  });
});
