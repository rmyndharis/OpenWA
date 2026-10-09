import { SessionEngineEventWiring, SessionEngineWiringHost } from './session-engine-event-wiring';
import { EventResponseEvent, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

/**
 * `event.response` names the responder the way `message.received` names its sender, so a consumer
 * can build an attendance list from the RSVPs alone. The lookup is best-effort and must never cost
 * an RSVP, and RSVPs must keep their arrival order even though each one waits on a lookup.
 */
describe('event.response wiring', () => {
  const rsvp = (overrides: Partial<EventResponseEvent> = {}): EventResponseEvent => ({
    eventMessageId: 'EVT1',
    chatId: '120363000000000001@g.us',
    responderId: '51987654321@c.us',
    fromMe: false,
    response: 'going',
    responseMessageId: 'RSVP1',
    timestamp: 1786000000,
    ...overrides,
  });

  const setup = (getContactById: jest.Mock, live = true) => {
    const dispatch = jest.fn<void, [string, string, Record<string, unknown>]>();
    const emitEventResponse = jest.fn();
    const host = {
      isLiveEngine: () => live,
      webhookService: { dispatch },
      eventsGateway: { emitEventResponse },
    } as unknown as SessionEngineWiringHost;
    const engine = { getContactById } as unknown as IWhatsAppEngine;
    const cb = new SessionEngineEventWiring({ logger: createLogger('test') }).buildCallbacks(
      'sess-1',
      engine,
      'sess-1-name',
      host,
    );
    return { cb, dispatch, emitEventResponse };
  };

  const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  it('adds the saved name and the profile name of the responder', async () => {
    const lookup = jest.fn().mockResolvedValue({ id: '51987654321@c.us', name: 'Ana Pérez', pushName: 'Ana' });
    const { cb, dispatch, emitEventResponse } = setup(lookup);

    cb.onEventResponse?.(rsvp());
    await settle();

    expect(lookup).toHaveBeenCalledWith('51987654321@c.us');
    const payload = { sessionId: 'sess-1', ...rsvp(), contact: { name: 'Ana Pérez', pushName: 'Ana' } };
    expect(dispatch).toHaveBeenCalledWith('sess-1', 'event.response', payload);
    expect(emitEventResponse).toHaveBeenCalledWith('sess-1', payload);
  });

  it('carries only the profile name for a contact that is not saved', async () => {
    const { cb, dispatch } = setup(jest.fn().mockResolvedValue({ id: 'x', pushName: 'Ana' }));

    cb.onEventResponse?.(rsvp());
    await settle();

    expect(dispatch.mock.calls[0][2]).toMatchObject({ contact: { pushName: 'Ana' } });
    expect((dispatch.mock.calls[0][2] as { contact: object }).contact).not.toHaveProperty('name');
  });

  it.each([
    ['an unknown contact', jest.fn().mockResolvedValue(null)],
    ['a contact without any name', jest.fn().mockResolvedValue({ id: 'x' })],
    ['a failed lookup', jest.fn().mockRejectedValue(new Error('store unavailable'))],
  ])('still publishes the RSVP, without contact, for %s', async (_label, lookup) => {
    const { cb, dispatch } = setup(lookup);

    cb.onEventResponse?.(rsvp());
    await settle();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][2]).not.toHaveProperty('contact');
  });

  it('keeps arrival order when an earlier lookup is slower', async () => {
    let release: (value: unknown) => void = () => undefined;
    const lookup = jest
      .fn()
      .mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
      .mockResolvedValue({ id: 'x', pushName: 'Ana' });
    const { cb, dispatch } = setup(lookup);

    cb.onEventResponse?.(rsvp({ response: 'going', responseMessageId: 'RSVP1' }));
    cb.onEventResponse?.(rsvp({ response: 'not_going', responseMessageId: 'RSVP2' }));
    await settle();
    expect(dispatch).not.toHaveBeenCalled();

    release({ id: 'x', pushName: 'Ana' });
    await settle();
    await settle();

    expect(dispatch.mock.calls.map(call => (call[2] as EventResponseEvent).responseMessageId)).toEqual([
      'RSVP1',
      'RSVP2',
    ]);
  });

  it('publishes nothing from an engine that is no longer live', async () => {
    const { cb, dispatch } = setup(jest.fn().mockResolvedValue(null), false);

    cb.onEventResponse?.(rsvp());
    await settle();

    expect(dispatch).not.toHaveBeenCalled();
  });
});
