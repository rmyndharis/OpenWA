import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/** Stand-ins for the library's USync classes: the query only has to carry what it was built with. */
class FakeUSyncUser {
  id?: string;
  withId(id: string): this {
    this.id = id;
    return this;
  }
}
class FakeUSyncQuery {
  protocols: string[] = [];
  users: FakeUSyncUser[] = [];
  withLIDProtocol(): this {
    this.protocols.push('lid');
    return this;
  }
  withContext(): this {
    return this;
  }
  withUser(user: FakeUSyncUser): this {
    this.users.push(user);
    return this;
  }
}
const library = { USyncQuery: FakeUSyncQuery, USyncUser: FakeUSyncUser } as unknown as typeof BaileysLib;

const PHONE = '60123456789';
const LID = '234767895240796@lid';

function setup(executeUSyncQuery: jest.Mock, budgetMs = 200, hasLibrary = true) {
  const recordLidMapping = jest.fn();
  const socket = { executeUSyncQuery } as unknown as WASocket;
  const host = {
    ensureReady: () => undefined,
    getSocket: () => socket,
    loadLib: hasLibrary ? () => Promise.resolve(library) : undefined,
    recordLidMapping,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
  } as unknown as BaileysContactsHost;
  return { contacts: new BaileysContacts(host, budgetMs), recordLidMapping };
}

describe('BaileysContacts.getContactLid', () => {
  it('returns the neutral lid of the row that answers for the phone', async () => {
    const execute = jest.fn().mockResolvedValue({ list: [{ id: `${PHONE}@s.whatsapp.net`, lid: LID }] });

    await expect(setup(execute).contacts.getContactLid(PHONE)).resolves.toBe(LID);

    const [query] = execute.mock.calls[0] as [FakeUSyncQuery];
    expect(query.protocols).toEqual(['lid']);
    expect(query.users.map(user => user.id)).toEqual([`${PHONE}@s.whatsapp.net`]);
  });

  it.each(['+60 123-456-789', `${PHONE}@c.us`, `${PHONE}@s.whatsapp.net`, `  ${PHONE}  `])(
    'asks about the phone number whatever spelling %j was typed in',
    async typed => {
      const execute = jest.fn().mockResolvedValue({ list: [{ id: `${PHONE}@s.whatsapp.net`, lid: LID }] });

      await expect(setup(execute).contacts.getContactLid(typed)).resolves.toBe(LID);

      const [query] = execute.mock.calls[0] as [FakeUSyncQuery];
      expect(query.users.map(user => user.id)).toEqual([`${PHONE}@s.whatsapp.net`]);
    },
  );

  it('keeps only the user part of a lid that carries a device suffix', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ list: [{ id: `${PHONE}@s.whatsapp.net`, lid: '234767895240796:3@lid' }] });

    await expect(setup(execute).contacts.getContactLid(PHONE)).resolves.toBe(LID);
  });

  it.each([
    ['an answer with no rows', { list: [] }],
    ['a row without a lid', { list: [{ id: `${PHONE}@s.whatsapp.net` }] }],
    ['a row that is for another number', { list: [{ id: '60999999999@s.whatsapp.net', lid: LID }] }],
    [
      'two rows for the number, which no answer is trusted for',
      {
        list: [
          { id: `${PHONE}@s.whatsapp.net`, lid: LID },
          { id: `${PHONE}@s.whatsapp.net`, lid: '999999999999999@lid' },
        ],
      },
    ],
    ['a lid that is not a privacy id', { list: [{ id: `${PHONE}@s.whatsapp.net`, lid: `${PHONE}@s.whatsapp.net` }] }],
  ])('answers null for %s', async (_label, answer) => {
    await expect(setup(jest.fn().mockResolvedValue(answer)).contacts.getContactLid(PHONE)).resolves.toBeNull();
  });

  it('rejects when WhatsApp did not answer, so an unanswered lookup is never read as "no lid"', async () => {
    // Baileys resolves undefined, not an error, when its own query timeout passes.
    const execute = jest.fn().mockResolvedValue(undefined);

    await expect(setup(execute).contacts.getContactLid(PHONE)).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('rejects as not ready, without querying, when the session cannot load the library', async () => {
    const execute = jest.fn();

    await expect(setup(execute, 200, false).contacts.getContactLid(PHONE)).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(execute).not.toHaveBeenCalled();
  });

  // Baileys rejects with a raw Boom when WhatsApp answers the query with an error node (data is the WA code)
  // and when the connection closes mid-query. Neither is a verdict about the number, and neither may become a 500.
  it('rejects a rate-limited query as throttled, a 503 the caller can back off from', async () => {
    const execute = jest.fn().mockRejectedValue(Object.assign(new Error('rate-overlimit'), { data: 429 }));

    await expect(setup(execute).contacts.getContactLid(PHONE)).rejects.toBeInstanceOf(EngineThrottledError);
  });

  it.each([
    ['an error node with a server code', Object.assign(new Error('internal-server-error'), { data: 500 })],
    ['an error node with a client code', Object.assign(new Error('bad-request'), { data: 400 })],
    [
      'a connection that closed mid-query',
      Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } }),
    ],
  ])('rejects %s as a failure to ask (503), never as lid: null', async (_label, failure) => {
    const execute = jest.fn().mockRejectedValue(failure);

    await expect(setup(execute).contacts.getContactLid(PHONE)).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('rejects when the query outruns the deadline', async () => {
    const execute = jest.fn(() => new Promise(() => undefined));

    await expect(setup(execute, 20).contacts.getContactLid(PHONE)).rejects.toBeInstanceOf(EngineTransportError);
  });

  it.each(['', '   ', 'abc', '@c.us'])('answers null without asking WhatsApp when %j holds no digits', async typed => {
    const execute = jest.fn();

    await expect(setup(execute).contacts.getContactLid(typed)).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('records no mapping: the lookup is a read', async () => {
    const execute = jest.fn().mockResolvedValue({ list: [{ id: `${PHONE}@s.whatsapp.net`, lid: LID }] });
    const { contacts, recordLidMapping } = setup(execute);

    await contacts.getContactLid(PHONE);

    expect(recordLidMapping).not.toHaveBeenCalled();
  });
});
