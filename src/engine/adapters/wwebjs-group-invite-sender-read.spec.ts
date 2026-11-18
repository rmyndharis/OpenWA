import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { readInviteSenderInPage } from './wwebjs-groups';
import { PAGE_RELOADING_MESSAGE } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Before an add, the adapter asks the page whether the library's invitation sender still exists. That is a read made
 * before anything is sent, like the group lookup that precedes it, so a command that outran the protocol timeout
 * answers the retryable 503 and a page that navigated under it the retryable 409, where it answered a bare 500. The add
 * itself does not converge when repeated, so it keeps the raw error.
 */
describe('the question about the invitation sender before an add', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };
  const timeout = new Error(
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls",
  );
  const destroyed = new Error('Execution context was destroyed, most likely because of a navigation.');

  afterEach(() => {
    delete g.window;
  });

  const adapterAsking = (
    answer: (fn: unknown) => Promise<unknown>,
    addParticipants = jest.fn().mockResolvedValue({}),
  ) => {
    const chat = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {}, addParticipants };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: {},
      getChatById: jest.fn().mockResolvedValue(chat),
      pupPage: { evaluate: jest.fn(answer) },
    };
    return { adapter, addParticipants };
  };

  it('answers 503 when it outruns the protocol timeout, and never starts the add', async () => {
    const { adapter, addParticipants } = adapterAsking(() => Promise.reject(timeout));

    await expect(adapter.addParticipants(GROUP, ['628111@c.us'])).rejects.toBeInstanceOf(EngineTransportError);
    expect(addParticipants).not.toHaveBeenCalled();
  });

  it('answers 409 when the page navigated under it, and never starts the add', async () => {
    const { adapter, addParticipants } = adapterAsking(() => Promise.reject(destroyed));

    const call = adapter.addParticipants(GROUP, ['628111@c.us']);

    await expect(call).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(call).rejects.toMatchObject({ message: PAGE_RELOADING_MESSAGE });
    expect(addParticipants).not.toHaveBeenCalled();
  });

  it('answers 409 on a document that has no require yet', async () => {
    const { adapter, addParticipants } = adapterAsking(fn => {
      g.window = {};
      return Promise.resolve().then(() => (fn as () => unknown)());
    });

    await expect(adapter.addParticipants(GROUP, ['628111@c.us'])).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(addParticipants).not.toHaveBeenCalled();
  });

  it('leaves the add its own raw error when it outruns the protocol timeout', async () => {
    const { adapter } = adapterAsking(
      fn => Promise.resolve(fn === readInviteSenderInPage),
      jest.fn().mockRejectedValue(timeout),
    );

    await expect(adapter.addParticipants(GROUP, ['628111@c.us'])).rejects.toBe(timeout);
  });
});
