import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import type { WASocket } from '@whiskeysockets/baileys';

/**
 * A status post and a status revoke both go through `sock.sendMessage` directly rather than the
 * messaging delegate's chokepoint, so each has to record its own id. Nothing else in the suite
 * covered either call.
 *
 * What the recording buys differs per call, and neither is "the post shows up as an inbound
 * message": the projector drops a `fromMe` status outright, so a post's echo would be discarded
 * anyway, just after the whole inbound pipeline had run for it. The revoke is the one with a
 * visible consequence. Its echo is a `protocolMessage` REVOKE, which the event handler turns into
 * `onMessageRevoked` whether or not it came from this session, so deleting your own status would
 * raise a `message.revoked` webhook for your own delete.
 */
function makeStatus(sendMessage: jest.Mock): { status: BaileysStatus; remembered: Array<string | null | undefined> } {
  // Records the argument verbatim, with no guard of its own: OwnSendRegistry.remember is what
  // ignores a nullish id (see baileys-own-sends.spec.ts), and a guard here would test the stub.
  const remembered: Array<string | null | undefined> = [];
  const host = {
    ensureReady: () => undefined,
    getSocket: () => ({ sendMessage }) as unknown as WASocket,
    toEngineJid: (jid: string) => jid,
    normalizedSelfJid: () => '628999@s.whatsapp.net',
    toUnixSeconds: () => 1700000000,
    rememberOwnSend: (id: string | null | undefined) => remembered.push(id),
  } as unknown as BaileysStatusHost;
  return { status: new BaileysStatus(host), remembered };
}

describe('BaileysStatus records the ids of the statuses this session sends', () => {
  it('remembers the id of a posted status', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' }, messageTimestamp: 1700000000 });
    const { status, remembered } = makeStatus(sendMessage);

    await status.postTextStatus('hello', { recipients: ['628111@s.whatsapp.net'] });

    expect(remembered).toEqual(['STATUS-1']);
  });

  it('remembers the id of a status revoke', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'REVOKE-1' } });
    const { status, remembered } = makeStatus(sendMessage);

    await status.deleteStatus('STATUS-1');

    expect(remembered).toEqual(['REVOKE-1']);
  });

  it('survives a send that echoes nothing back, and hands on the nothing it found', async () => {
    // The library can resolve a send with no message object at all. Reading the id off it must not
    // throw, and the registry is what decides that an absent id is not worth remembering.
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const { status, remembered } = makeStatus(sendMessage);

    await expect(status.deleteStatus('STATUS-1')).resolves.not.toThrow();

    expect(remembered).toEqual([undefined]);
  });
});
