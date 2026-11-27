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
    const keepStoredCopy = jest.fn();
    const forgetKeptInbound = jest.fn();
    const keepStoredChange = jest.fn();
    const keepStoredWipe = jest.fn();
    const isStoredCopyKept = jest.fn((_sessionId: string, messageId: string) => messageId === 'M1');
    const host = {
      isLiveEngine: () => live,
      messages: {
        keepUnreadInbound,
        isChangeKept,
        keepStoredCopy,
        isStoredCopyKept,
        forgetKeptInbound,
        keepStoredChange,
        keepStoredWipe,
      },
    } as unknown as SessionEngineWiringHost;
    const callbacks = new SessionEngineEventWiring({ logger: createLogger('test') }).buildCallbacks(
      'sess-1',
      {} as IWhatsAppEngine,
      'sess-1-name',
      host,
    );
    return {
      callbacks,
      keepUnreadInbound,
      isChangeKept,
      keepStoredCopy,
      forgetKeptInbound,
      keepStoredChange,
      keepStoredWipe,
    };
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
    const { callbacks, keepUnreadInbound, keepStoredCopy } = setup(false);

    callbacks.onInboundUnreadable?.({ messageId: 'ENV-A', raw: '{}' });
    callbacks.onStoredCopyRefused?.({ messageId: 'M1', raw: '{}' });

    expect(keepUnreadInbound).not.toHaveBeenCalled();
    expect(keepStoredCopy).not.toHaveBeenCalled();
  });

  it('drops what is kept for the store once the engine clears it, from an engine no longer live too', () => {
    const { callbacks, forgetKeptInbound } = setup(false);

    callbacks.onStoredAccountCleared?.();

    expect(forgetKeptInbound).toHaveBeenCalledWith('sess-1');
  });

  it('keeps a clear of the stores the database refused, from an engine no longer live too', () => {
    const { callbacks, keepStoredWipe } = setup(false);

    callbacks.onStoredAccountWipeRefused?.({ raw: '{}' });

    expect(keepStoredWipe).toHaveBeenCalledWith('sess-1', { raw: '{}' });
  });

  it('keeps a change of a stored copy the store refused with the projector, from a live engine only', () => {
    const kept = { messageId: 'M1', changeId: 'RV-1', raw: '{}', kind: 'blank' as const };
    const live = setup(true);
    const gone = setup(false);

    live.callbacks.onStoredChangeRefused?.(kept);
    gone.callbacks.onStoredChangeRefused?.(kept);

    expect(live.keepStoredChange).toHaveBeenCalledWith('sess-1', kept);
    expect(gone.keepStoredChange).not.toHaveBeenCalled();
  });

  it('keeps a copy the store refused with the projector, and answers whether one is kept', () => {
    const { callbacks, keepStoredCopy } = setup(true);

    callbacks.onStoredCopyRefused?.({ messageId: 'M1', raw: '{}' });

    expect(keepStoredCopy).toHaveBeenCalledWith('sess-1', { messageId: 'M1', raw: '{}' });
    expect([callbacks.isStoredCopyKept?.('M1'), callbacks.isStoredCopyKept?.('M2')]).toEqual([true, false]);
  });
});
