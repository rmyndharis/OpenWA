import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import type { WASocket } from '@whiskeysockets/baileys';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';

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
function makeStatus(
  sendMessage: jest.Mock,
  proxyUrl?: string,
): { status: BaileysStatus; remembered: Array<string | null | undefined> } {
  // Records the argument verbatim, with no guard of its own: OwnSendRegistry.remember is what
  // ignores a nullish id (see baileys-own-sends.spec.ts), and a guard here would test the stub.
  const remembered: Array<string | null | undefined> = [];
  const host = {
    sessionProxyUrl: () => proxyUrl,
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
    const sendMessage = jest
      .fn()
      .mockResolvedValueOnce({ key: { id: 'STATUS-1' } })
      .mockResolvedValueOnce({ key: { id: 'REVOKE-1' } });
    const { status, remembered } = makeStatus(sendMessage);
    await status.postTextStatus('hello', { recipients: ['628111@s.whatsapp.net'] });

    await status.deleteStatus('STATUS-1');

    expect(remembered).toEqual(['STATUS-1', 'REVOKE-1']);
  });

  it('survives a send that echoes nothing back, and hands on the nothing it found', async () => {
    // The library can resolve a send with no message object at all. Reading the id off it must not
    // throw, and the registry is what decides that an absent id is not worth remembering.
    const sendMessage = jest
      .fn()
      .mockResolvedValueOnce({ key: { id: 'STATUS-1' } })
      .mockResolvedValue(undefined);
    const { status, remembered } = makeStatus(sendMessage);
    await status.postTextStatus('hello', { recipients: ['628111@s.whatsapp.net'] });

    await expect(status.deleteStatus('STATUS-1')).resolves.not.toThrow();

    expect(remembered).toEqual(['STATUS-1', undefined]);
  });
});

describe('BaileysStatus addresses a status revoke to the status recipients', () => {
  // Baileys sends a status stanza to exactly its statusJidList, the revoke included: without one the
  // revoke reaches nobody, the send still resolves, and the status stays up for every viewer.
  it('sends the revoke to the recipients the status was posted to', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } });
    const { status } = makeStatus(sendMessage);
    await status.postTextStatus('hello', { recipients: ['628111@s.whatsapp.net', '628222@s.whatsapp.net'] });

    await status.deleteStatus('STATUS-1');

    expect(sendMessage).toHaveBeenLastCalledWith(
      'status@broadcast',
      { delete: { remoteJid: 'status@broadcast', fromMe: true, id: 'STATUS-1', participant: '628999@s.whatsapp.net' } },
      { statusJidList: ['628111@s.whatsapp.net', '628222@s.whatsapp.net'] },
    );
  });

  it('refuses a status whose recipients it does not know rather than revoke it for nobody', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } });
    const { status } = makeStatus(sendMessage);
    await status.postTextStatus('hello', { recipients: ['628111@s.whatsapp.net'] });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      await expect(status.deleteStatus('POSTED-ELSEWHERE')).rejects.toBeInstanceOf(EngineRefusedError);
      clock.mockReturnValue(now + 25 * 3_600_000); // the posted one has expired by now
      await expect(status.deleteStatus('STATUS-1')).rejects.toBeInstanceOf(EngineRefusedError);
    } finally {
      clock.mockRestore();
    }
    expect(sendMessage).toHaveBeenCalledTimes(1); // the post alone
  });
});

describe('BaileysStatus media upload deadline', () => {
  const image = { data: Buffer.from([0xff, 0xd8, 0xff]), mimetype: 'image/jpeg' };

  // Baileys sets none, and a session proxy's agent has no idle timeout to end a stalled upload.
  it('bounds the upload of a status posted through a session proxy', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } });
    const { status } = makeStatus(sendMessage, 'http://proxy.example:8080');

    await status.postImageStatus(image, { recipients: ['628111@s.whatsapp.net'] });

    expect(sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      expect.anything(),
      expect.objectContaining({ mediaUploadTimeoutMs: BAILEYS_QUERY_BUDGET_MS }),
    );
  });

  // Node's global agent already ends a stalled upload after 5 s idle; a request timeout would replace it.
  it('leaves a direct session to the idle timeout of the agent it uploads through', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } });
    const { status } = makeStatus(sendMessage);

    await status.postImageStatus(image, { recipients: ['628111@s.whatsapp.net'] });

    expect(sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      expect.anything(),
      expect.not.objectContaining({ mediaUploadTimeoutMs: expect.anything() as unknown }),
    );
  });
});
