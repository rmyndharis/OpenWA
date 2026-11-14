import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';
import { bytesOf, decryptSecretPayload, messageSecretOf, senderForms, withoutDevice } from './baileys-secret-payload';

/**
 * The key construction the library itself uses to decrypt a poll vote or an event RSVP (Utils/
 * process-message: HMAC over the secret with a zero key, then HMAC of `info || 0x01` under that), which
 * is HKDF-SHA256 with a zero salt. Written out here, not imported, so the module under test is held to
 * the library's own formula and not to a copy of itself.
 */
function referenceKey(secret: Uint8Array, info: string): Buffer {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
  return createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

function seal(
  label: string,
  secret: Uint8Array,
  ids: { target: string; author: string; modifier: string },
  plaintext: Buffer,
  iv = Buffer.alloc(12, 9),
): { payload: Buffer; iv: Buffer } {
  const cipher = createCipheriv(
    'aes-256-gcm',
    referenceKey(secret, `${ids.target}${ids.author}${ids.modifier}${label}`),
    iv,
  );
  return { payload: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]), iv };
}

const secret = Buffer.alloc(32, 0x42);
const lid = '39900313301142@lid';
const phone = '6281234567890@s.whatsapp.net';
const ids = { target: '3EB0A1B2C3D4E5F60718', author: lid, modifier: lid };

describe('decryptSecretPayload', () => {
  it('derives the same key as the library does for a poll vote or an RSVP', () => {
    const info = 'MSGID' + lid + lid + 'Poll Vote';
    expect(Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), Buffer.from(info), 32))).toEqual(
      referenceKey(secret, info),
    );
  });

  it.each([
    ['edit', 'Message Edit'],
    ['reaction', 'Enc Reaction'],
  ] as const)('reads a %s sealed under its label', (kind, label) => {
    const { payload, iv } = seal(label, secret, ids, Buffer.from('the plaintext'));

    const plain = decryptSecretPayload({
      kind,
      secret,
      iv,
      payload,
      targetId: ids.target,
      targetAuthors: [lid],
      modifiers: [lid],
    });

    expect(plain?.toString()).toBe('the plaintext');
  });

  it('finds the pair of ids a payload was sealed under among the forms of each party', () => {
    // Written under phone addressing by the author, edited by a sender the key names by lid.
    const { payload, iv } = seal('Message Edit', secret, { ...ids, author: phone, modifier: lid }, Buffer.from('x'));

    const plain = decryptSecretPayload({
      kind: 'edit',
      secret,
      iv,
      payload,
      targetId: ids.target,
      targetAuthors: [lid, phone],
      modifiers: ['999@lid', lid],
    });

    expect(plain?.toString()).toBe('x');
  });

  describe('answers undefined, and never throws, for', () => {
    const valid = seal('Message Edit', secret, ids, Buffer.from('payload'));
    const base = {
      kind: 'edit' as const,
      secret,
      iv: valid.iv,
      payload: valid.payload,
      targetId: ids.target,
      targetAuthors: [lid],
      modifiers: [lid],
    };

    it('a reaction label used on an edit', () => {
      expect(decryptSecretPayload({ ...base, kind: 'reaction' })).toBeUndefined();
    });

    it('a different sender of the edit than the one it was sealed for', () => {
      expect(decryptSecretPayload({ ...base, modifiers: ['111@lid'] })).toBeUndefined();
    });

    it('a different author of the target than the one it was sealed for', () => {
      expect(decryptSecretPayload({ ...base, targetAuthors: ['111@lid'] })).toBeUndefined();
    });

    it('another target id', () => {
      expect(decryptSecretPayload({ ...base, targetId: 'OTHER' })).toBeUndefined();
    });

    it('another secret', () => {
      expect(decryptSecretPayload({ ...base, secret: Buffer.alloc(32, 1) })).toBeUndefined();
    });

    it('an altered payload', () => {
      const altered = Buffer.from(valid.payload);
      altered[0] ^= 0xff;
      expect(decryptSecretPayload({ ...base, payload: altered })).toBeUndefined();
    });

    it('an altered tag', () => {
      const altered = Buffer.from(valid.payload);
      altered[altered.length - 1] ^= 0x01;
      expect(decryptSecretPayload({ ...base, payload: altered })).toBeUndefined();
    });

    // Each case below decrypts when its guard is removed: the payload is sealed with that very parameter, so
    // the answer comes from the guard and not from the authentication tag.
    it('a secret that is not 32 bytes', () => {
      const short = Buffer.alloc(16, 0x42);
      const sealed = seal('Message Edit', short, ids, Buffer.from('x'));
      expect(decryptSecretPayload({ ...base, secret: short, iv: sealed.iv, payload: sealed.payload })).toBeUndefined();
    });

    it('an iv that is not 12 bytes', () => {
      const sealed = seal('Message Edit', secret, ids, Buffer.from('x'), Buffer.alloc(16, 9));
      expect(decryptSecretPayload({ ...base, iv: sealed.iv, payload: sealed.payload })).toBeUndefined();
    });

    it('a payload of only a tag', () => {
      const sealed = seal('Message Edit', secret, ids, Buffer.alloc(0));
      expect(sealed.payload).toHaveLength(16);
      expect(decryptSecretPayload({ ...base, iv: sealed.iv, payload: sealed.payload })).toBeUndefined();
    });

    it('a payload past the ceiling', () => {
      const sealed = seal('Message Edit', secret, ids, Buffer.alloc(256 * 1024 + 1, 0x61));
      expect(decryptSecretPayload({ ...base, iv: sealed.iv, payload: sealed.payload })).toBeUndefined();
      const within = seal('Message Edit', secret, ids, Buffer.alloc(64 * 1024, 0x61));
      expect(decryptSecretPayload({ ...base, iv: within.iv, payload: within.payload })).toHaveLength(64 * 1024);
    });

    it('no target id', () => {
      const sealed = seal('Message Edit', secret, { ...ids, target: '' }, Buffer.from('x'));
      expect(decryptSecretPayload({ ...base, iv: sealed.iv, payload: sealed.payload, targetId: '' })).toBeUndefined();
    });

    it('no candidate ids', () => {
      expect(decryptSecretPayload({ ...base, targetAuthors: [], modifiers: [] })).toBeUndefined();
    });
  });

  it('tries only a few forms of each party, so a crafted key cannot multiply the work', () => {
    const { payload, iv } = seal('Message Edit', secret, ids, Buffer.from('x'));
    const many = Array.from({ length: 50 }, (_, i) => `${i}@lid`);

    // The sealing pair sits past the fourth form of the sender, so it is never tried.
    expect(
      decryptSecretPayload({
        kind: 'edit',
        secret,
        iv,
        payload,
        targetId: ids.target,
        targetAuthors: [lid],
        modifiers: [...many, lid],
      }),
    ).toBeUndefined();
  });
});

describe('bytesOf', () => {
  const bytes = Buffer.from([1, 2, 3, 250]);

  it.each([
    ['a Uint8Array', new Uint8Array(bytes)],
    ['a Buffer', bytes],
    ['base64 text', bytes.toString('base64')],
    ['a serialized Buffer with a byte array', { type: 'Buffer', data: [...bytes] }],
    ['a serialized Buffer with base64 text', { type: 'Buffer', data: bytes.toString('base64') }],
  ])('reads %s', (_name, value) => {
    expect(bytesOf(value)).toEqual(bytes);
  });

  it.each([[undefined], [null], [''], [42], [{}], [{ type: 'Buffer' }]])('answers undefined for %p', value => {
    expect(bytesOf(value)).toBeUndefined();
  });
});

describe('messageSecretOf', () => {
  const secretText = Buffer.alloc(32, 7).toString('base64');

  it('reads the secret at the top level, in either shape', () => {
    expect(messageSecretOf({ conversation: 'x', messageContextInfo: { messageSecret: secretText } })).toEqual(
      Buffer.alloc(32, 7),
    );
    expect(messageSecretOf({ messageContextInfo: { messageSecret: new Uint8Array(32).fill(7) } })).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  it('finds it inside the wrappers a disappearing or view-once message adds', () => {
    const inner = { messageContextInfo: { messageSecret: secretText }, imageMessage: {} };
    expect(messageSecretOf({ ephemeralMessage: { message: { viewOnceMessageV2: { message: inner } } } })).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  // The library unwraps these as well when it normalizes a message, so a secret that only sits inside one
  // (a photo of an album, a group status) has to be found there.
  it.each(['associatedChildMessage', 'groupStatusMessage', 'groupStatusMessageV2', 'pollCreationMessageV4'])(
    'finds it inside %s',
    wrapper => {
      const inner = { messageContextInfo: { messageSecret: secretText }, imageMessage: {} };
      expect(messageSecretOf({ [wrapper]: { message: inner } })).toEqual(Buffer.alloc(32, 7));
    },
  );

  it.each([[undefined], [null], [{ conversation: 'x' }], [{ messageContextInfo: {} }], ['text']])(
    'answers undefined for %p',
    message => {
      expect(messageSecretOf(message)).toBeUndefined();
    },
  );

  it('does not loop on a wrapper that holds itself', () => {
    const looped: Record<string, unknown> = {};
    looped.ephemeralMessage = { message: looped };

    expect(messageSecretOf(looped)).toBeUndefined();
  });
});

describe('senderForms', () => {
  const own = ['6280000000000@s.whatsapp.net', '5550001@lid'];

  it("names the account's own ids for a message it sent", () => {
    expect(senderForms({ remoteJid: '120@g.us', fromMe: true, participant: 'ignored@lid' }, own)).toEqual(own);
  });

  it("takes a group message's sender from its participant and the twin of it", () => {
    expect(senderForms({ remoteJid: '120@g.us', participant: lid, participantAlt: phone, fromMe: false }, own)).toEqual(
      [lid, phone],
    );
  });

  it('takes a 1:1 message from the chat when the participant is empty, as a live key leaves it', () => {
    expect(senderForms({ remoteJid: lid, remoteJidAlt: phone, participant: '', fromMe: false }, own)).toEqual([
      lid,
      phone,
    ]);
  });

  it('drops the device suffix, repeats and ids that name a group or a list', () => {
    expect(
      senderForms({ remoteJid: '120@g.us', participant: '39900313301142:7@lid', participantAlt: lid }, own),
    ).toEqual([lid]);
    expect(senderForms({ remoteJid: '120@g.us', fromMe: false }, own)).toEqual([]);
    expect(senderForms({ remoteJid: 'status@broadcast', fromMe: false }, own)).toEqual([]);
  });
});

describe('withoutDevice', () => {
  it.each([
    ['6281234567890:12@s.whatsapp.net', '6281234567890@s.whatsapp.net'],
    ['39900313301142:3@lid', '39900313301142@lid'],
    ['39900313301142@lid', '39900313301142@lid'],
  ])('%s -> %s', (from, to) => {
    expect(withoutDevice(from)).toBe(to);
  });
});
