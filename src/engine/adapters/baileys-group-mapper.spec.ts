import type { GroupMetadata } from '@whiskeysockets/baileys';
import { findSelfParticipant, mapBaileysGroup, mapBaileysGroupInfo } from './baileys-group-mapper';
const identity = (jid: string): string => jid;

const meta = (over: Partial<GroupMetadata> = {}): GroupMetadata => ({
  id: '123-456@g.us',
  subject: 'My Group',
  owner: '628999@s.whatsapp.net',
  desc: 'a description',
  creation: 1700000000,
  announce: false,
  participants: [
    { id: '628999@s.whatsapp.net', admin: 'superadmin' },
    { id: '628111@s.whatsapp.net', admin: null },
    { id: '628222@s.whatsapp.net', admin: 'admin' },
  ],
  ...over,
});

describe('mapBaileysGroup', () => {
  it('maps the summary shape and flags self-admin', () => {
    const g = mapBaileysGroup(meta(), '628999:3@s.whatsapp.net');
    expect(g).toEqual({
      id: '123-456@g.us',
      name: 'My Group',
      participantsCount: 3,
      isAdmin: true, // self is superadmin
      linkedParentJID: null,
    });
  });

  it('isAdmin is false when self is a non-admin member', () => {
    expect(mapBaileysGroup(meta(), '628111@s.whatsapp.net').isAdmin).toBe(false);
  });

  it('isAdmin is true when self is a plain admin', () => {
    const m = meta({ participants: [{ id: '628222@s.whatsapp.net', admin: 'admin' }] });
    expect(mapBaileysGroup(m, '628222@s.whatsapp.net').isAdmin).toBe(true);
  });

  it('carries the linked community parent when present', () => {
    expect(mapBaileysGroup(meta({ linkedParent: '999@g.us' }), 'x@s.whatsapp.net').linkedParentJID).toBe('999@g.us');
  });
});

describe('mapBaileysGroupInfo', () => {
  /**
   * isAnnounce is the group SETTING; isReadOnly is what that setting means for THIS account, which
   * is the field a client uses to disable its composer. Copying announce into both told an admin of
   * an announce-only group that they could not post, while whatsapp-web.js reads WA Web's own
   * per-account flag and says they can.
   */
  it('reads isReadOnly against the calling account, not the group setting', () => {
    const announceOnly = meta({ announce: true });
    // 628999 is a superadmin and 628222 an admin in the fixture; 628111 is a plain member.
    expect(mapBaileysGroupInfo(announceOnly, identity, '628999@s.whatsapp.net').isReadOnly).toBe(false);
    expect(mapBaileysGroupInfo(announceOnly, identity, '628222@s.whatsapp.net').isReadOnly).toBe(false);
    expect(mapBaileysGroupInfo(announceOnly, identity, '628111@s.whatsapp.net').isReadOnly).toBe(true);
    // The setting itself is unchanged for every caller.
    expect(mapBaileysGroupInfo(announceOnly, identity, '628999@s.whatsapp.net').isAnnounce).toBe(true);
    // An open group is writable for everyone, admin or not.
    expect(mapBaileysGroupInfo(meta({ announce: false }), identity, '628111@s.whatsapp.net').isReadOnly).toBe(false);
  });

  it('maps full info incl. participants admin/superadmin', () => {
    const info = mapBaileysGroupInfo(meta({ announce: true }));
    expect(info.id).toBe('123-456@g.us');
    expect(info.name).toBe('My Group');
    expect(info.description).toBe('a description');
    expect(info.owner).toBe('628999@s.whatsapp.net');
    expect(info.createdAt).toBe(1700000000);
    expect(info.isAnnounce).toBe(true);
    expect(info.isReadOnly).toBe(true);
    expect(info.participants).toEqual([
      { id: '628999@s.whatsapp.net', number: '628999', name: undefined, isAdmin: true, isSuperAdmin: true },
      { id: '628111@s.whatsapp.net', number: '628111', name: undefined, isAdmin: false, isSuperAdmin: false },
      { id: '628222@s.whatsapp.net', number: '628222', name: undefined, isAdmin: true, isSuperAdmin: false },
    ]);
  });

  it('maps the group settings fields (announce / restrict→locked / ephemeralDuration→ephemeralSeconds)', () => {
    const info = mapBaileysGroupInfo(meta({ announce: true, restrict: true, ephemeralDuration: 86400 }));
    expect(info.announce).toBe(true);
    expect(info.locked).toBe(true);
    expect(info.ephemeralSeconds).toBe(86400);
  });

  it('leaves the settings fields undefined when the metadata does not carry them', () => {
    const m = meta();
    delete m.announce;
    const info = mapBaileysGroupInfo(m);
    expect(info.announce).toBeUndefined();
    expect(info.locked).toBeUndefined();
    expect(info.ephemeralSeconds).toBeUndefined();
  });

  it('canonicalizes participant ids and owner through the supplied normalizer (lid -> resolved phone)', () => {
    // A lid-addressed group: participants/owner arrive as @lid. The normalizer (the adapter's
    // session-store) resolves the known lid to its phone so both sides of the admin check share a dialect.
    const m = meta({
      owner: '111@lid',
      participants: [
        { id: '111@lid', admin: 'superadmin' },
        { id: '222@lid', admin: null },
      ],
    });
    const normalize = (jid: string) => (jid === '111@lid' ? '628111@c.us' : jid);
    const info = mapBaileysGroupInfo(m, normalize);
    expect(info.owner).toBe('628111@c.us');
    expect(info.participants).toEqual([
      { id: '628111@c.us', number: '628111', name: undefined, isAdmin: true, isSuperAdmin: true },
      { id: '222@lid', number: '222', name: undefined, isAdmin: false, isSuperAdmin: false }, // unresolved: kept raw
    ]);
  });

  it('mapBaileysGroup flags self-admin across the dialect split via the normalizer', () => {
    const m = meta({ participants: [{ id: '111@lid', admin: 'admin' }] });
    // Self is reported in the raw protocol dialect; the normalizer folds both onto @c.us so they match.
    const normalize = (jid: string) => (jid === '111@lid' || jid === '628111@s.whatsapp.net' ? '628111@c.us' : jid);
    expect(mapBaileysGroup(m, '628111@s.whatsapp.net', normalize).isAdmin).toBe(true);
  });
});

describe('findSelfParticipant across identity kinds', () => {
  const phone = '628111';

  it('does not take a lid member for the account because its digits match the phone number', () => {
    const participants = [
      { id: `${phone}@lid`, admin: 'admin' as const },
      { id: `${phone}@s.whatsapp.net`, admin: null },
    ];
    const metadata = meta({ participants, announce: true });

    expect(findSelfParticipant(metadata, `${phone}@s.whatsapp.net`, identity)).toBe(participants[1]);
    expect(mapBaileysGroup(metadata, `${phone}@s.whatsapp.net`, identity).isAdmin).toBe(false);
    expect(mapBaileysGroupInfo(metadata, identity, `${phone}@s.whatsapp.net`).isReadOnly).toBe(true);
  });

  it('does not take a phone member for the account when only its lid is known', () => {
    const metadata = meta({ participants: [{ id: `${phone}@s.whatsapp.net`, admin: 'admin' }] });

    expect(findSelfParticipant(metadata, `${phone}@lid`, identity)).toBeUndefined();
  });

  it('finds nothing for an account whose id is not known', () => {
    expect(findSelfParticipant(meta({ participants: [{ id: '', admin: 'admin' }] }), '', identity)).toBeUndefined();
  });
});
