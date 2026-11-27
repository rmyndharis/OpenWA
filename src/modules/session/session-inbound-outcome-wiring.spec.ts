import { SessionEngineEventWiring, SessionEngineWiringHost } from './session-engine-event-wiring';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

describe('onMessage wiring', () => {
  const message = { id: 'M1', chatId: '628111@c.us', body: 'hi' } as IncomingMessage;

  const setup = (answer: unknown) => {
    const engine = {} as IWhatsAppEngine;
    const handleInboundMessage = jest.fn(() => answer);
    const host = { isLiveEngine: () => true, messages: { handleInboundMessage } } as unknown as SessionEngineWiringHost;
    const callbacks = new SessionEngineEventWiring({ logger: createLogger('test') }).buildCallbacks(
      'sess-1',
      engine,
      'sess-1-name',
      host,
    );
    return { callbacks, engine, handleInboundMessage };
  };

  it('answers the engine with the receipt the projector gave for the message', () => {
    const receipt = { settled: Promise.resolve({ conflict: true }) };
    const { callbacks, engine, handleInboundMessage } = setup(receipt);

    const returned = callbacks.onMessage?.(message);

    expect(returned).toBe(receipt);
    expect(handleInboundMessage).toHaveBeenCalledWith('sess-1', engine, message, undefined);
  });

  it('answers nothing when the projector commits nothing', () => {
    const { callbacks } = setup(undefined);

    expect(callbacks.onMessage?.(message)).toBeUndefined();
  });
});

describe('onInboundUnreadable wiring', () => {
  const setup = (live: boolean) => {
    const keepUnreadInbound = jest.fn();
    const isChangeKept = jest.fn((_sessionId: string, targetId: string) => targetId === 'M1');
    const host = {
      isLiveEngine: () => live,
      messages: { keepUnreadInbound, isChangeKept },
    } as unknown as SessionEngineWiringHost;
    const callbacks = new SessionEngineEventWiring({ logger: createLogger('test') }).buildCallbacks(
      'sess-1',
      {} as IWhatsAppEngine,
      'sess-1-name',
      host,
    );
    return { callbacks, keepUnreadInbound, isChangeKept };
  };

  it('keeps the message with the projector, to hand back once the database answers', () => {
    const { callbacks, keepUnreadInbound } = setup(true);

    callbacks.onInboundUnreadable?.({ messageId: 'ENV-A', raw: '{}', targetId: 'M1' });

    expect(keepUnreadInbound).toHaveBeenCalledWith('sess-1', { messageId: 'ENV-A', raw: '{}', targetId: 'M1' });
  });

  it("answers from the projector whether a change of a message is kept, for the session's own records", () => {
    const { callbacks, isChangeKept } = setup(true);

    expect([callbacks.isChangeKept?.('M1'), callbacks.isChangeKept?.('M2')]).toEqual([true, false]);
    expect(isChangeKept).toHaveBeenCalledWith('sess-1', 'M1');
  });

  it('keeps nothing from an engine that is no longer live', () => {
    const { callbacks, keepUnreadInbound } = setup(false);

    callbacks.onInboundUnreadable?.({ messageId: 'ENV-A', raw: '{}' });

    expect(keepUnreadInbound).not.toHaveBeenCalled();
  });
});
