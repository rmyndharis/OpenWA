import { Boom } from '@hapi/boom';
import { BaileysAdapter } from './baileys.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSentError } from '../../common/errors/engine-not-sent.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

const CONNECTION_CLOSED = 428;

describe('BaileysAdapter.sendProduct when the connection drops or the socket is replaced during catalog lookup', () => {
  const readyAdapter = (getCatalog: jest.Mock) => {
    const adapter = new BaileysAdapter({
      sessionId: 's',
      dbSessionId: 's-db',
      authDir: './data/sessions',
    });
    const sendMessage = jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 });
    const onWhatsApp = jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }]));
    const sock = {
      user: { id: '628177:1@s.whatsapp.net' },
      getCatalog,
      onWhatsApp,
      sendMessage,
    };
    const lifecycle = (adapter as unknown as { lifecycle: { status: EngineStatus; sock: unknown } }).lifecycle;
    lifecycle.status = EngineStatus.READY;
    lifecycle.sock = sock;
    return { adapter, lifecycle, sock, sendMessage };
  };

  it.each([
    ['Boom(Connection Closed, 428)', () => new Boom('Connection Closed', { statusCode: CONNECTION_CLOSED })],
    ['the bare numeric close code from ws close', () => 1006],
  ])(
    'maps %s during the pre-send catalog lookup to EngineNotSentError so pacing is freed and the send breaker is not tripped',
    async (_label, makeCloseRejection) => {
      const getCatalog = jest.fn().mockRejectedValue(makeCloseRejection());
      const { adapter, sendMessage } = readyAdapter(getCatalog);

      const error: unknown = await adapter.sendProduct('628123456789@c.us', 'P1').catch((e: unknown) => e);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(EngineNotSentError);
      expect(sentNothing(error)).toBe(true);
      expect(countsTowardSendBreaker(error)).toBe(false);
    },
  );

  it('refuses with 409 EngineNotReadyError when the socket is torn down while getCatalog is in flight', async () => {
    const getCatalog = jest.fn(() => {
      built.lifecycle.status = EngineStatus.DISCONNECTED;
      built.lifecycle.sock = null;
      return Promise.reject(new Boom('Connection Closed', { statusCode: CONNECTION_CLOSED }));
    });
    const built = readyAdapter(getCatalog);

    const error: unknown = await built.adapter.sendProduct('628123456789@c.us', 'P1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(sentNothing(error)).toBe(true);
    expect(countsTowardSendBreaker(error)).toBe(false);
  });

  it('refuses with 409 instead of sending on the replacement socket when reconnected during getCatalog', async () => {
    const newSendMessage = jest.fn().mockResolvedValue({ key: { id: 'NEW1' }, messageTimestamp: 1 });
    const newSock = {
      user: { id: '628199:1@s.whatsapp.net' },
      onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
      sendMessage: newSendMessage,
    };
    const getCatalog = jest.fn(() => {
      built.lifecycle.sock = newSock;
      return Promise.resolve({
        products: [
          {
            id: 'P1',
            name: 'Widget',
            description: 'desc',
            price: 10,
            currency: 'USD',
            imageUrls: { original: 'https://example.com/p1.jpg' },
            availability: 'in stock',
          },
        ],
        nextPageCursor: undefined,
      });
    });
    const built = readyAdapter(getCatalog);

    const error: unknown = await built.adapter.sendProduct('628123456789@c.us', 'P1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(built.sendMessage).not.toHaveBeenCalled();
    expect(newSendMessage).not.toHaveBeenCalled();
  });

  it('sends the product card normally when the catalog lookup succeeds on the active socket', async () => {
    const getCatalog = jest.fn(() =>
      Promise.resolve({
        products: [
          {
            id: 'P1',
            name: 'Widget',
            description: 'desc',
            price: 10,
            currency: 'USD',
            imageUrls: { original: 'https://example.com/p1.jpg' },
            availability: 'in stock',
          },
        ],
        nextPageCursor: undefined,
      }),
    );
    const { adapter, sendMessage } = readyAdapter(getCatalog);

    const res = await adapter.sendProduct('628123456789@c.us', 'P1', 'Check this out');

    expect(res.id).toBe('M1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
