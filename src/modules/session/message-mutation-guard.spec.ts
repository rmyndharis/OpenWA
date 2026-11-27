import { MessageDirection } from '../message/entities/message.entity';
import {
  mutationTargetsForeignRow,
  mutationTargetsForeignRowPersisted,
  phoneKey,
  phoneSpellings,
} from './message-mutation-guard';

const OUT = MessageDirection.OUTGOING;
const IN = MessageDirection.INCOMING;

describe('mutationTargetsForeignRow', () => {
  const direct = '628111@c.us';
  const group = '120363000000000001@g.us';

  it('lets a change made by the sender of a one-to-one message through', () => {
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind: 'edit', chatId: direct, fromMe: false }),
    ).toBeNull();
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: OUT }, { kind: 'revoke', chatId: direct, fromMe: true }),
    ).toBeNull();
  });

  it('refuses a one-to-one edit or revoke made by the other party', () => {
    for (const kind of ['edit', 'revoke'] as const) {
      expect(
        mutationTargetsForeignRow({ chatId: direct, direction: OUT }, { kind, chatId: direct, fromMe: false }),
      ).toBe('direction');
      expect(mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind, chatId: direct, fromMe: true })).toBe(
        'direction',
      );
    }
  });

  it('refuses a change that names a message of another chat, whatever the kind', () => {
    for (const kind of ['edit', 'revoke', 'reaction'] as const) {
      expect(mutationTargetsForeignRow({ chatId: group, direction: IN }, { kind, chatId: direct })).toBe('chat');
      expect(mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind, chatId: group })).toBe('chat');
      expect(
        mutationTargetsForeignRow({ chatId: '120363000000000002@g.us', direction: IN }, { kind, chatId: group }),
      ).toBe('chat');
    }
  });

  // The account's own message to a broadcast list (or status post) is filed under the list, while each
  // recipient reacts from their own one-to-one chat, as the engine adapters already allow.
  it('lets a recipient react to a message the account sent to a broadcast list', () => {
    for (const list of ['1700000002@broadcast', 'status@broadcast']) {
      expect(
        mutationTargetsForeignRow({ chatId: list, direction: OUT }, { kind: 'reaction', chatId: direct }),
      ).toBeNull();
      // Only a reaction, and only to the account's own message.
      expect(mutationTargetsForeignRow({ chatId: list, direction: OUT }, { kind: 'edit', chatId: direct })).toBe(
        'chat',
      );
      expect(
        mutationTargetsForeignRow(
          { chatId: list, direction: IN, author: '628999@c.us' },
          { kind: 'reaction', chatId: direct },
        ),
      ).toBe('chat');
    }
  });

  // Earlier versions filed a message received through a contact's list under the list id, with its sender as
  // the author, and it is shown in the chat with that sender: the sender's change names that chat.
  it('lets the sender of a received list message change it from their own chat', () => {
    const row = { chatId: '1700000009@broadcast', direction: IN, author: direct };
    for (const kind of ['edit', 'revoke', 'reaction'] as const) {
      expect(mutationTargetsForeignRow(row, { kind, chatId: direct, fromMe: false })).toBeNull();
    }
    // The account's own phone reacting to it names the sender's chat too, and another person's chat is foreign.
    expect(mutationTargetsForeignRow(row, { kind: 'reaction', chatId: direct, fromMe: true })).toBeNull();
    expect(mutationTargetsForeignRow(row, { kind: 'reaction', chatId: '628222@c.us' })).toBe('chat');
    expect(mutationTargetsForeignRow(row, { kind: 'edit', chatId: group, fromMe: false })).toBe('chat');
  });

  // A REST send keeps the number as its caller wrote it ('+', spaces, with or without the mobile marker
  // digit) while the engine reports its own spelling, which can differ either way.
  it('reads the spellings of one phone number as one chat', () => {
    const spellings: Array<[string, string]> = [
      ['+628111@c.us', '628111@c.us'],
      ['62 811 1@c.us', '628111@c.us'],
      ['5511987654321@c.us', '551187654321@c.us'],
      ['5215512345678@c.us', '525512345678@c.us'],
      ['5491123456789@c.us', '541123456789@c.us'],
    ];
    for (const [stored, reported] of spellings) {
      expect(
        mutationTargetsForeignRow({ chatId: stored, direction: OUT }, { kind: 'reaction', chatId: reported }),
      ).toBeNull();
    }
  });

  it('still calls two different phone numbers different chats', () => {
    for (const stored of ['628222@c.us', '+628222@s.whatsapp.net', '628222', '551187654322@c.us']) {
      expect(
        mutationTargetsForeignRow({ chatId: stored, direction: IN }, { kind: 'reaction', chatId: '628111@c.us' }),
      ).toBe('chat');
    }
  });

  it('requires a trusted pairing before a LID can change a phone-keyed row', async () => {
    for (const kind of ['edit', 'revoke', 'reaction'] as const) {
      const row = { chatId: direct, direction: IN };
      const source = { kind, chatId: '111@lid', fromMe: false };
      expect(mutationTargetsForeignRow(row, source)).toBe('chat');
      expect(await mutationTargetsForeignRowPersisted(row, source, () => Promise.resolve(null))).toBe('chat');
      expect(await mutationTargetsForeignRowPersisted(row, source, () => Promise.resolve('628222'))).toBe('chat');
      expect(await mutationTargetsForeignRowPersisted(row, source, () => Promise.resolve('628111'))).toBeNull();
      expect(
        await mutationTargetsForeignRowPersisted(
          { chatId: '111@lid', direction: IN },
          { ...source, chatId: '222@lid' },
          () => Promise.resolve('628111'),
        ),
      ).toBe('chat');
    }
  });

  // A delete or edit through the API names the chat the engine found the message in and the one its caller named.
  it('takes a change through the API when the chat its caller named is the row chat', async () => {
    const row = { chatId: direct, direction: OUT };
    const source = { kind: 'revoke' as const, chatId: '111@lid', callerChatId: direct };
    expect(mutationTargetsForeignRow(row, source)).toBeNull();
    expect(mutationTargetsForeignRow({ chatId: '111@lid', direction: OUT }, source)).toBeNull();
    // Foreign only when both chats say so, and the reason is the first one's.
    expect(mutationTargetsForeignRow({ chatId: '628777@c.us', direction: OUT }, source)).toBe('chat');
    expect(mutationTargetsForeignRow(row, { ...source, kind: 'edit', fromMe: false })).toBe('chat');
    // A lid named by the caller is resolved like the engine's.
    const lidCaller = { kind: 'revoke' as const, chatId: '628777@c.us', callerChatId: '222@lid' };
    expect(await mutationTargetsForeignRowPersisted(row, lidCaller, () => Promise.resolve('628111'))).toBeNull();
    expect(await mutationTargetsForeignRowPersisted(row, lidCaller, () => Promise.resolve(null))).toBe('chat');
  });

  // A row a message hook filed elsewhere keeps what the engine reported, and only that judges a change to it.
  it('judges a row a hook moved by its engine ref alone', async () => {
    const moved = { chatId: '628999@c.us', direction: OUT, engineRef: { chatId: direct, direction: IN } };
    expect(mutationTargetsForeignRow(moved, { kind: 'revoke', chatId: direct, fromMe: false })).toBeNull();
    expect(mutationTargetsForeignRow(moved, { kind: 'revoke', chatId: '628999@c.us', fromMe: true })).toBe('chat');
    // Neither the chat an API caller named nor how a delivery was filed brings the filed columns back.
    const filedChat = { chatId: '628999@c.us', fromMe: true };
    expect(
      mutationTargetsForeignRow(moved, { kind: 'revoke', chatId: '628777@c.us', callerChatId: '628999@c.us' }),
    ).toBe('chat');
    expect(mutationTargetsForeignRow(moved, { kind: 'edit', chatId: '628777@c.us', filedAs: filedChat })).toBe('chat');
    // A row without one may take a delivery as a hook filed it.
    const legacy = { chatId: '628999@c.us', direction: OUT };
    expect(mutationTargetsForeignRow(legacy, { kind: 'edit', chatId: direct, filedAs: filedChat })).toBeNull();
    expect(
      await mutationTargetsForeignRowPersisted(
        { chatId: '111@lid', direction: IN, engineRef: { chatId: '222@lid', direction: IN } },
        { kind: 'revoke', chatId: direct, fromMe: false },
        jid => Promise.resolve(jid === '222@lid' ? '628111' : null),
      ),
    ).toBeNull();
  });

  // The send routes store the chat id as the caller wrote it, in either dialect the docs give, while the
  // engines report the neutral one.
  it('reads the id a REST send stored in any dialect of the chat as the same chat', () => {
    for (const stored of ['628111@s.whatsapp.net', '628111', '628111:7@s.whatsapp.net', '628111@C.US']) {
      for (const kind of ['reaction', 'edit', 'revoke'] as const) {
        expect(
          mutationTargetsForeignRow({ chatId: stored, direction: OUT }, { kind, chatId: direct, fromMe: true }),
        ).toBeNull();
      }
    }
    expect(mutationTargetsForeignRow({ chatId: '628111', direction: OUT }, { kind: 'reaction', chatId: group })).toBe(
      'chat',
    );
  });

  it('lets any participant react, and an admin delete a message the account sent', () => {
    expect(
      mutationTargetsForeignRow({ chatId: group, direction: OUT }, { kind: 'reaction', chatId: group, fromMe: false }),
    ).toBeNull();
    expect(
      mutationTargetsForeignRow({ chatId: group, direction: OUT }, { kind: 'revoke', chatId: group, fromMe: false }),
    ).toBeNull();
  });

  describe('a group delete by a member the roster shows is no admin', () => {
    const member = { kind: 'revoke', chatId: group, fromMe: false, author: '628333@c.us', admin: false } as const;
    const withAdmin = (admin?: boolean) => ({ ...member, admin });

    it('is refused for a message the account sent or another member wrote, and applied to their own', () => {
      expect(mutationTargetsForeignRow({ chatId: group, direction: OUT }, member)).toBe('author');
      expect(mutationTargetsForeignRow({ chatId: group, direction: IN, author: '628111@c.us' }, member)).toBe('author');
      expect(mutationTargetsForeignRow({ chatId: group, direction: IN, author: '628333@c.us' }, member)).toBeNull();
      expect(mutationTargetsForeignRow({ chatId: group, direction: IN }, member)).toBeNull();
    });

    it('is applied to anyone when the sender is an admin or the roster could not say', () => {
      for (const admin of [true, undefined]) {
        expect(mutationTargetsForeignRow({ chatId: group, direction: OUT }, withAdmin(admin))).toBeNull();
        expect(
          mutationTargetsForeignRow({ chatId: group, direction: IN, author: '628111@c.us' }, withAdmin(admin)),
        ).toBeNull();
      }
    });

    it('compares a lid sender with the author only through a reported pairing', async () => {
      const byLid = { ...member, author: '333@lid' };
      const row = { chatId: group, direction: IN, author: '628333@c.us' };
      expect(mutationTargetsForeignRow(row, byLid)).toBeNull();
      expect(await mutationTargetsForeignRowPersisted(row, byLid, () => Promise.resolve(null))).toBeNull();
      expect(await mutationTargetsForeignRowPersisted(row, byLid, () => Promise.resolve('628333'))).toBeNull();
      expect(await mutationTargetsForeignRowPersisted(row, byLid, () => Promise.resolve('628111'))).toBe('author');
    });
  });

  it('refuses a group edit by somebody other than the author, and one of the account message by a member', () => {
    const row = { chatId: group, direction: IN, author: '628111@c.us' };
    expect(
      mutationTargetsForeignRow(row, { kind: 'edit', chatId: group, fromMe: false, author: '628111@c.us' }),
    ).toBeNull();
    expect(mutationTargetsForeignRow(row, { kind: 'edit', chatId: group, fromMe: false, author: '628222@c.us' })).toBe(
      'author',
    );
    expect(
      mutationTargetsForeignRow({ chatId: group, direction: OUT }, { kind: 'edit', chatId: group, fromMe: false }),
    ).toBe('direction');
  });

  it('says nothing when the engine does not say who made the change', () => {
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: OUT }, { kind: 'revoke', chatId: direct }),
    ).toBeNull();
  });
});

describe('phoneSpellings', () => {
  it.each([
    ['a Brazilian mobile written with its ninth digit', '5511987654321', ['5511987654321', '551187654321']],
    ['a Brazilian mobile written without it', '551187654321', ['551187654321', '5511987654321']],
    ['a Mexican mobile written with the 1', '5215512345678', ['5215512345678', '525512345678']],
    ['a Mexican mobile written without it', '525512345678', ['525512345678', '5215512345678']],
    ['an Argentine mobile written with the 9', '5491123456789', ['5491123456789', '541123456789']],
    ['an Argentine mobile written without it', '541123456789', ['541123456789', '5491123456789']],
  ])('gives both spellings of %s, and phoneKey folds them into one number', (_case, number, spellings) => {
    expect(phoneSpellings(number)).toEqual(spellings);
    expect(new Set(spellings.map(phoneKey)).size).toBe(1);
  });

  it.each(['6281234567890', '14155550123', '447911123456'])('gives only %s itself, which no rule covers', number => {
    expect(phoneSpellings(number)).toEqual([number]);
  });

  it('reads the number out of the way it is written', () => {
    expect(phoneSpellings('+55 11 98765-4321')).toEqual(['5511987654321', '551187654321']);
    expect(phoneSpellings('not a number')).toEqual([]);
  });

  it('never gives a spelling that phoneKey folds into another number', () => {
    // After its marker this Argentine number goes on with a 9: taking a 9 off twice names somebody else.
    for (const number of ['54991123456', '5499', '549', '55119', '521']) {
      const spellings = phoneSpellings(number);
      expect(spellings).toContain(number);
      expect(new Set(spellings.map(phoneKey))).toEqual(new Set([phoneKey(number)]));
    }
  });
});
