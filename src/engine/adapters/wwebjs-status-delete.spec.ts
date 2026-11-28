import type { Client } from 'whatsapp-web.js';
import { WwebjsStatus } from './wwebjs-status';
import { WwebjsLifecycle } from './wwebjs-lifecycle';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Client.revokeStatusMessage refuses a status that is not the account's own with a bare page-side
 * string (Client.js revokeStatusMessage), which Puppeteer rejects with as-is. GET /status lists
 * contacts' statuses, so their ids reach DELETE /status/:id, and the refusal answered 500.
 */
const REFUSAL = 'Invalid usage! Can only revoke the message its from own status broadcast';

function makeStatus(outcome: unknown): { status: WwebjsStatus; reportIfPageTransportError: jest.Mock } {
  const client = { revokeStatusMessage: jest.fn().mockRejectedValue(outcome) };
  const reportIfPageTransportError = jest.fn();
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    isPageTransportError: (error: unknown) => WwebjsLifecycle.prototype.isPageTransportError.call({}, error),
    reportIfPageTransportError,
    logger: createLogger('wwebjs-status-delete.spec'),
  } as unknown as WwebjsEngineHost;
  return { status: new WwebjsStatus(host), reportIfPageTransportError };
}

describe('deleteStatus on whatsapp-web.js', () => {
  it("answers the library's refusal of a foreign status with a 403", async () => {
    await expect(makeStatus(REFUSAL).status.deleteStatus('false_status@broadcast_ABC_628111@c.us')).rejects.toThrow(
      EngineRefusedError,
    );
  });

  it('still answers a dead page with a 503, even as a bare string', async () => {
    const { status, reportIfPageTransportError } = makeStatus('Protocol error: Target closed');

    await expect(status.deleteStatus('x')).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalled();
  });

  it('propagates any other failure unchanged', async () => {
    const other = new Error('Invalid usage! as an Error is not the library refusal');

    await expect(makeStatus(other).status.deleteStatus('x')).rejects.toBe(other);
    await expect(makeStatus('something else').status.deleteStatus('x')).rejects.toBe('something else');
  });
});

describe('collectStatuses when a page call fails', () => {
  const transportErr = new Error('Protocol error (Runtime.callFunctionOn): Session closed.');

  function makeCollector(firstMedia: unknown) {
    const reportIfPageTransportError = jest.fn();
    const secondMsgMedia = jest.fn().mockResolvedValue(undefined);
    const host = {
      ensureReady: jest.fn(),
      getClient: () => ({}) as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportErr,
      reportIfPageTransportError,
      capInboundMediaFor: jest.fn().mockRejectedValueOnce(firstMedia).mockImplementation(secondMsgMedia),
      logger: createLogger('wwebjs-status-collect.spec'),
    } as unknown as WwebjsEngineHost;
    const status = new WwebjsStatus(host) as unknown as {
      collectStatuses(broadcasts: unknown[]): Promise<Array<{ id: string; media?: unknown }>>;
    };
    return { status, reportIfPageTransportError, secondMsgMedia };
  }

  const imageStory = (n: number) => ({
    id: { _serialized: `false_status@broadcast_${n}` },
    type: 'image',
    hasMedia: true,
    timestamp: 1_700_000_000 + n,
  });
  const textStory = (n: number) => ({
    id: { _serialized: `false_status@broadcast_${n}` },
    type: 'chat',
    timestamp: 1_700_000_000 + n,
  });

  const poster = (n: number) => jest.fn().mockResolvedValue({ id: { _serialized: `62811${n}@c.us` } });

  it('answers a page that dies downloading a story with the 503, not the stories read before it', async () => {
    const { status, reportIfPageTransportError, secondMsgMedia } = makeCollector(transportErr);
    const laterContact = jest.fn();

    await expect(
      status.collectStatuses([
        { msgs: [textStory(1)], getContact: poster(1) },
        { msgs: [imageStory(2), imageStory(3)], getContact: poster(2) },
        { msgs: [textStory(4)], getContact: laterContact },
      ]),
    ).rejects.toThrow(EngineTransportError);

    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportErr, 'collectStatuses');
    expect(secondMsgMedia).not.toHaveBeenCalled();
    expect(laterContact).not.toHaveBeenCalled();
  });

  it("answers a page that dies reading a poster's contact with the 503, not the stories read before it", async () => {
    const { status, reportIfPageTransportError } = makeCollector(undefined);
    const laterContact = jest.fn();

    await expect(
      status.collectStatuses([
        { msgs: [textStory(5)], getContact: poster(5) },
        { msgs: [textStory(6)], getContact: jest.fn().mockRejectedValue(transportErr) },
        { msgs: [textStory(7)], getContact: laterContact },
      ]),
    ).rejects.toThrow(EngineTransportError);

    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportErr, 'collectStatuses');
    expect(laterContact).not.toHaveBeenCalled();
  });

  it('still lists every story, without the media, when a download fails for another reason', async () => {
    const { status, reportIfPageTransportError, secondMsgMedia } = makeCollector(new Error('media key expired'));

    const collected = await status.collectStatuses([{ msgs: [imageStory(8), imageStory(9)], getContact: poster(8) }]);

    expect(collected.map(s => s.id)).toEqual(['false_status@broadcast_8', 'false_status@broadcast_9']);
    expect(collected[0].media).toBeUndefined();
    expect(secondMsgMedia).toHaveBeenCalled();
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });
});
