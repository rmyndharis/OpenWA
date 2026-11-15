import {
  chatKind,
  isAddressableParticipant,
  isChannelJid,
  authorOfMessageId,
  chatOfPage,
  isIndividualWid,
  messageIdByAuthor,
  messageIdInChat,
  parseWaId,
  rememberChatOfPage,
  toNeutralJid,
  toParticipantWid,
  userPart,
} from './wa-id';

describe('wa-id', () => {
  describe('userPart', () => {
    it('strips the domain and the device suffix', () => {
      expect(userPart('628111@c.us')).toBe('628111');
      expect(userPart('628111:12@s.whatsapp.net')).toBe('628111');
      expect(userPart('120363-456@g.us')).toBe('120363-456');
    });
  });

  describe('parseWaId', () => {
    it('classifies each dialect, folding @s.whatsapp.net and @c.us into one user kind', () => {
      expect(parseWaId('628111@c.us')).toMatchObject({ kind: 'user', userPart: '628111' });
      expect(parseWaId('628111@s.whatsapp.net')).toMatchObject({ kind: 'user', userPart: '628111' });
      expect(parseWaId('628111:3@s.whatsapp.net')).toMatchObject({ kind: 'user', userPart: '628111', device: '3' });
      expect(parseWaId('120-456@g.us')).toMatchObject({ kind: 'group' });
      expect(parseWaId('111@lid')).toMatchObject({ kind: 'lid', userPart: '111' });
      expect(parseWaId('status@broadcast')).toMatchObject({ kind: 'status' });
      expect(parseWaId('abc@newsletter')).toMatchObject({ kind: 'newsletter' });
      expect(parseWaId('not-a-jid')).toMatchObject({ kind: 'unknown' });
    });

    it('classifies broadcast and lowercases the parsed parts', () => {
      expect(parseWaId('123@broadcast')).toMatchObject({ kind: 'broadcast', userPart: '123' });
      expect(parseWaId('ABC@NEWSLETTER')).toMatchObject({ kind: 'newsletter', userPart: 'abc' });
      expect(parseWaId('AbCd@LID')).toMatchObject({ kind: 'lid', userPart: 'abcd' });
    });
  });

  describe('isChannelJid', () => {
    it('is true only for a @newsletter (channel) JID', () => {
      expect(isChannelJid('120363401234567890@newsletter')).toBe(true);
      expect(isChannelJid('ABC@NEWSLETTER')).toBe(true); // case-insensitive
    });

    it('is false for user, group, lid, broadcast and status JIDs (they resolve to a real Chat)', () => {
      expect(isChannelJid('628111@c.us')).toBe(false);
      expect(isChannelJid('628111@s.whatsapp.net')).toBe(false);
      expect(isChannelJid('120-456@g.us')).toBe(false);
      expect(isChannelJid('111@lid')).toBe(false);
      expect(isChannelJid('123@broadcast')).toBe(false);
      expect(isChannelJid('status@broadcast')).toBe(false);
      expect(isChannelJid('not-a-jid')).toBe(false);
    });
  });

  describe('toNeutralJid', () => {
    it('maps @s.whatsapp.net (and device suffixes) to @c.us, idempotent on @c.us', () => {
      expect(toNeutralJid('628111@s.whatsapp.net')).toBe('628111@c.us');
      expect(toNeutralJid('628111:12@s.whatsapp.net')).toBe('628111@c.us');
      expect(toNeutralJid('628111@c.us')).toBe('628111@c.us');
    });

    it('keeps groups as @g.us and passes status / empty through', () => {
      expect(toNeutralJid('120-456@g.us')).toBe('120-456@g.us');
      expect(toNeutralJid('status@broadcast')).toBe('status@broadcast');
      expect(toNeutralJid('')).toBe('');
    });

    it('resolves a lid to <phone>@c.us when the resolver knows it, else keeps the raw lid', () => {
      const resolve = (jid: string) => (jid === '111@lid' ? '628999' : null);
      expect(toNeutralJid('111@lid', resolve)).toBe('628999@c.us');
      expect(toNeutralJid('222@lid', resolve)).toBe('222@lid'); // unresolved: kept as a privacy id
      expect(toNeutralJid('111@lid')).toBe('111@lid'); // no resolver supplied
    });

    it('keeps newsletter and broadcast channels in their own dialect', () => {
      expect(toNeutralJid('120363-abc@newsletter')).toBe('120363-abc@newsletter');
      expect(toNeutralJid('120363-def@broadcast')).toBe('120363-def@broadcast');
    });

    it('passes an unrecognized format through unchanged', () => {
      expect(toNeutralJid('weird-thing')).toBe('weird-thing');
    });
  });

  describe('chatKind', () => {
    it.each([
      ['628111@c.us', 'individual'],
      ['628111@s.whatsapp.net', 'individual'],
      ['628111:12@s.whatsapp.net', 'individual'],
      ['4707@lid', 'individual'],
      ['12036@g.us', 'group'],
      ['abc@newsletter', 'channel'],
      ['status@broadcast', 'status'],
      ['12036@broadcast', 'broadcast'],
      ['not-a-jid', 'unknown'],
      ['', 'unknown'],
    ])('classifies %s as %s', (jid, expected) => {
      expect(chatKind(jid)).toBe(expected);
    });
  });

  describe('isAddressableParticipant', () => {
    it.each([
      ['628123456789', true],
      ['628123456789@c.us', true],
      ['628123456789@s.whatsapp.net', true],
      ['12345678901234567890@lid', true],
      ['628123456789:12@c.us', true],
      ['  628123456789@c.us  ', true],
      ['NOT A USER', false],
      ['', false],
      ['1234', false],
      ['12036@g.us', false],
      ['status@broadcast', false],
      ['abc@newsletter', false],
      ['abc@weird', false],
      // A recognised domain is not enough: the user-part has to look like a WhatsApp id, or the
      // string still reaches the page-side createWid and throws there — the very failure the guard
      // exists to prevent. Reproduced against a live session before this row was added.
      ['NOT A USER@c.us', false],
      ['abc@c.us', false],
      ['abc@s.whatsapp.net', false],
      ['abc@lid', false],
      ['@c.us', false],
      ['x y@c.us', false],
      ['0@c.us', false],
      ['-1@c.us', false],
      ['+628123456789@c.us', false],
    ])('classifies %s as %s', (value, expected) => {
      expect(isAddressableParticipant(value)).toBe(expected);
    });
  });

  describe('toParticipantWid', () => {
    it('qualifies a bare number to the c.us dialect', () => {
      expect(toParticipantWid('628123456789')).toBe('628123456789@c.us');
    });

    it('leaves an already-neutral id untouched', () => {
      expect(toParticipantWid('628123456789@c.us')).toBe('628123456789@c.us');
      expect(toParticipantWid('12345678901234567890@lid')).toBe('12345678901234567890@lid');
    });

    it.each([
      [' 628123456789:3@C.US ', '628123456789@c.us'],
      ['628123456789@s.whatsapp.net', '628123456789@c.us'],
      ['628123456789@hosted', '628123456789@c.us'],
      ['12345678901234567890:5@LID', '12345678901234567890@lid'],
      ['12345678901234567890@hosted.lid', '12345678901234567890@lid'],
    ])('reduces the accepted variant %s to the neutral id %s, keeping a lid a lid', (value, expected) => {
      // isIndividualWid accepts every one of these, so forwarding the raw string would hand the
      // engine an id the group's participant list is not keyed by.
      expect(isIndividualWid(value)).toBe(true);
      expect(toParticipantWid(value)).toBe(expected);
    });

    it.each([['abc@weird'], ['abc'], ['NOT A USER'], ['']])(
      'leaves %s alone rather than minting a nonsense id from it',
      value => {
        // The old rule was `p.includes('@') ? p : p + '@c.us'`, which turned every un-domained
        // string into one — `abc` became `abc@c.us`, a well-formed id naming nobody. Keying on the
        // bare-number shape instead means only a number is ever qualified. (`abc@weird` alone would
        // NOT show this: the old rule passed it through too, so it discriminates nothing.)
        expect(toParticipantWid(value)).toBe(value);
      },
    );
  });

  /**
   * WhatsApp issues Meta-hosted dialects of a phone id and a lid, and Baileys decodes them off the
   * wire (`WAJIDDomains.HOSTED` = 128, `HOSTED_LID` = 129). They used to parse as `unknown` here, so
   * an id we had emitted on GET /chats was refused with a 400 when it was handed back to us.
   *
   * They fold into `user` and `lid` rather than becoming kinds of their own, because the user-part
   * names the SAME account: Baileys rewrites `<n>@hosted` to `<n>@s.whatsapp.net` on every inbound
   * message (`cleanMessage`). A separate kind would split one person's history in two.
   */
  describe('Meta-hosted dialects', () => {
    it('folds each hosted dialect into the entity it names', () => {
      expect(parseWaId('628111@hosted')).toMatchObject({ kind: 'user', userPart: '628111' });
      expect(parseWaId('4707@hosted.lid')).toMatchObject({ kind: 'lid', userPart: '4707' });
      expect(parseWaId('628111:3@hosted')).toMatchObject({ kind: 'user', userPart: '628111', device: '3' });
      expect(parseWaId('ABC@HOSTED.LID')).toMatchObject({ kind: 'lid', userPart: 'abc' });
    });

    it('does not confuse @hosted.lid with @hosted: the domain is the whole suffix', () => {
      // Same user-part, different entity: one is a phone number, the other a privacy id.
      expect(parseWaId('4707@hosted.lid').kind).toBe('lid');
      expect(parseWaId('4707@hosted').kind).toBe('user');
    });

    it('accepts them as individuals, which is what the guards refused before', () => {
      expect(isIndividualWid('628123456789@hosted')).toBe(true);
      expect(isIndividualWid('12345678901234567890@hosted.lid')).toBe(true);
      expect(isAddressableParticipant('628123456789@hosted')).toBe(true);
      // The user-part still has to look like an id: the domain alone was never enough.
      expect(isIndividualWid('NOT A USER@hosted')).toBe(false);
      expect(isIndividualWid('1234@hosted.lid')).toBe(false);
    });

    it('normalizes to the neutral dialect of the same account, so history stays in one place', () => {
      expect(toNeutralJid('628111@hosted')).toBe('628111@c.us');
      expect(toNeutralJid('628111:3@hosted')).toBe('628111@c.us');
      // An unresolved hosted lid keeps the lid dialect, exactly like a plain @lid.
      expect(toNeutralJid('4707@hosted.lid')).toBe('4707@lid');
      expect(toNeutralJid('4707@hosted.lid', () => '628111')).toBe('628111@c.us');
    });

    it('surfaces as an individual chat, not unknown', () => {
      expect(chatKind('628111@hosted')).toBe('individual');
      expect(chatKind('4707@hosted.lid')).toBe('individual');
    });
  });

  describe('messageIdInChat', () => {
    it("rewrites a person's chat to the form given, whichever way round", () => {
      expect(messageIdInChat('false_628111222@c.us_3EB0AA', '148000111@lid')).toBe('false_148000111@lid_3EB0AA');
      expect(messageIdInChat('true_148000111@lid_3EB0AA', '628111222@c.us')).toBe('true_628111222@c.us_3EB0AA');
      expect(messageIdInChat('true_628111222@c.us_3EB0AA_out', '148000111@lid')).toBe('true_148000111@lid_3EB0AA_out');
      expect(messageIdInChat('false_628111222@c.us_3EB0AA', ' 148000111@lid\n')).toBe('false_148000111@lid_3EB0AA');
    });

    it('leaves an id that names a group, a channel, a broadcast list, the status feed or no person at all', () => {
      for (const id of [
        'false_120363000111@g.us_3EB0AA_628111222@c.us',
        'false_120363111222@newsletter_3EB0AA',
        'false_1700000000@broadcast_3EB0AA_628111222@c.us',
        'false_status@broadcast_3EB0AA_628111222@c.us',
        'false_not a user@c.us_3EB0AA',
      ]) {
        expect(messageIdInChat(id, '148000111@lid')).toBe(id);
      }
    });

    it("leaves every id when the chat given is not a person's, or would not leave a serialized id", () => {
      const id = 'false_628111222@c.us_3EB0AA';
      for (const chat of ['120363000111@g.us', 'status@broadcast', 'foo_bar@c.us', '628111222333:1_2@c.us', '']) {
        expect(messageIdInChat(id, chat)).toBe(id);
      }
    });

    it('leaves an id that is not a full serialized one', () => {
      for (const id of [
        '3EB0AA',
        'false_3EB0AA',
        'false_ORIG_3',
        'maybe_628111222@c.us_3EB0AA',
        'false_628111222@c.us_A_B_C',
      ]) {
        expect(messageIdInChat(id, '148000111@lid')).toBe(id);
      }
    });
  });

  describe('messageIdByAuthor', () => {
    const GROUP = 'false_120363000111@g.us_3EB0AA';

    it("rewrites a group message's author to the form given, whichever way round", () => {
      expect(messageIdByAuthor(`${GROUP}_628111222@c.us`, '148000111@lid')).toBe(`${GROUP}_148000111@lid`);
      expect(messageIdByAuthor(`${GROUP}_148000111@lid`, '628111222@c.us')).toBe(`${GROUP}_628111222@c.us`);
      expect(messageIdByAuthor(`${GROUP}_148000111@lid`, '628111222:2@s.whatsapp.net')).toBe(
        `${GROUP}_628111222:2@s.whatsapp.net`,
      );
      expect(authorOfMessageId(`${GROUP}_628111222@c.us`)).toBe('628111222@c.us');
      // The hosted dialects name a person too, as an author read and as one written.
      for (const hosted of ['628111222@hosted', '148000111@hosted.lid']) {
        expect(authorOfMessageId(`${GROUP}_${hosted}`)).toBe(hosted);
        expect(messageIdByAuthor(`${GROUP}_628111222@c.us`, hosted)).toBe(`${GROUP}_${hosted}`);
      }
    });

    it('leaves an id that names no author of a group', () => {
      for (const id of [
        GROUP,
        'true_628111222@c.us_3EB0AA_out',
        'false_628999111@c.us_3EB0AA_628111222@c.us',
        'false_status@broadcast_3EB0AA_628111222@c.us',
        `${GROUP}_120363000222@g.us`,
        `${GROUP}_ 628111222@c.us `,
        `${GROUP}_628111222:1 2@c.us`,
        `${GROUP}_628111222@C.US`,
        `${GROUP}_1234@c.us`,
        '3EB0AA',
        `${GROUP}_x_y`,
      ]) {
        expect(messageIdByAuthor(id, '148000111@lid')).toBe(id);
        expect(authorOfMessageId(id)).toBeUndefined();
      }
    });

    it("leaves every id when the author given is not a person's id as an engine writes it", () => {
      const id = `${GROUP}_628111222@c.us`;
      for (const author of [
        '120363000111@g.us',
        'out',
        'foo_bar@c.us',
        '628111222:1_2@c.us',
        '628111222:1 2@c.us',
        '628111222:1:bad@c.us',
        ' 148000111@lid',
        '148000111@lid\n',
        '148000111@LID',
        '',
      ]) {
        expect(messageIdByAuthor(id, author)).toBe(id);
      }
    });
  });

  describe('chatOfPage', () => {
    it('gives back the chat kept for that very page, and nothing for another', () => {
      const page: unknown[] = [];
      rememberChatOfPage(page, '148000111@lid');
      expect(chatOfPage(page)).toBe('148000111@lid');
      expect(chatOfPage([])).toBeUndefined();
    });
  });
});
