jest.mock('./baileys-audio-probe', () => ({
  describeVideo: jest.fn(),
  describeAudio: jest.fn(),
}));

import type { WASocket } from '@whiskeysockets/baileys';
import { describeVideo } from './baileys-audio-probe';
import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

/**
 * A status post is written to the socket it was prepared on. A session that holds a different socket when the
 * post is written (a reconnect, or a logout and a relink) answers 409 and sends nothing, whatever the two sockets
 * have in common: a wrapper that forwards sendMessage to one shared function must not make two sockets look like one.
 */
describe('a status post whose socket is replaced while its media is prepared', () => {
  const video = { data: Buffer.from('video'), mimetype: 'video/mp4' };
  const options = { recipients: ['628111@s.whatsapp.net'] };

  /**
   * A host as the session's: one current socket that both getters answer. It is replaced by `later` while the
   * thumbnail is made, when `replace` is set.
   */
  const statusWith = (first: WASocket, later: WASocket, replace: boolean): BaileysStatus => {
    let current = first;
    jest.mocked(describeVideo).mockImplementation(() => {
      if (replace) current = later;
      return Promise.resolve({ jpegThumbnail: null as unknown as string });
    });
    const host = {
      sessionProxyUrl: () => undefined,
      ensureReady: () => undefined,
      getSocket: () => current,
      getSocketOrNull: () => current,
      toEngineJid: (jid: string) => jid,
      normalizedSelfJid: () => '628999@s.whatsapp.net',
      toUnixSeconds: () => 1700000000,
      rememberOwnSend: () => undefined,
    } as unknown as BaileysStatusHost;
    return new BaileysStatus(host);
  };

  it('sends nothing and answers 409 when the other socket shares the first one sendMessage', async () => {
    const shared = jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } });
    const first = { sendMessage: shared } as unknown as WASocket;
    const later = { sendMessage: shared } as unknown as WASocket;

    await expect(statusWith(first, later, true).postVideoStatus(video, options)).rejects.toBeInstanceOf(
      EngineNotReadyError,
    );
    expect(shared).not.toHaveBeenCalled();
  });

  it('sends nothing and answers 409 when the other socket has a sendMessage of its own', async () => {
    const first = { sendMessage: jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } }) };
    const later = { sendMessage: jest.fn().mockResolvedValue({ key: { id: 'STATUS-2' } }) };

    await expect(
      statusWith(first as unknown as WASocket, later as unknown as WASocket, true).postVideoStatus(video, options),
    ).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(first.sendMessage).not.toHaveBeenCalled();
    expect(later.sendMessage).not.toHaveBeenCalled();
  });

  it('posts on the socket it was prepared on when the session still holds it', async () => {
    const socket = { sendMessage: jest.fn().mockResolvedValue({ key: { id: 'STATUS-1' } }) };

    await statusWith(socket as unknown as WASocket, socket as unknown as WASocket, false).postVideoStatus(
      video,
      options,
    );

    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
  });
});
