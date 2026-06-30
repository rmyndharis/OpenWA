import { isChannelJid, parseWaId, toNeutralJid, userPart } from './wa-id';

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
});
