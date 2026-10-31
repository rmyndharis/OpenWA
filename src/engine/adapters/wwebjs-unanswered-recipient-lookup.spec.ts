import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EnginePageError } from '../../common/errors/engine-page.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

/**
 * A send to a contact WhatsApp has moved to privacy-id addressing fails with `No LID for user` on its
 * phone id, and the adapter then asks `getNumberId` again. Only an ANSWER from that lookup (null, or
 * the same id again) says the recipient cannot be reached. A lookup that failed to answer says
 * nothing about the recipient, so the send must not be reported as an unreachable recipient (a 400
 * telling the caller the number is not on WhatsApp) on the strength of it. What the caller gets
 * instead is WhatsApp Web's own refusal as an engine error whose outcome is not proven.
 */
describe('a send whose recipient lookup did not answer', () => {
  const ready = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };
  const noLid = (): Error => new Error('No LID for user');
  const outcomeOf = (send: Promise<unknown>): Promise<unknown> =>
    send.then(
      () => 'sent',
      (error: unknown) => error,
    );
  const sentMessage = { id: { _serialized: 'OUT1' }, timestamp: 1700000001 };

  it.each([
    ['a page-side failure', () => new Error('t: t')],
    [
      'a protocol timeout',
      () =>
        new Error(
          "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
        ),
    ],
  ])('is not reported as an unreachable recipient after %s', async (_label, lookupError) => {
    const getNumberId = jest.fn().mockRejectedValue(lookupError());
    const sendMessage = jest.fn().mockRejectedValue(noLid());
    const adapter = ready({ getNumberId, sendMessage });

    const outcome = await outcomeOf(adapter.sendTextMessage('628123456789@c.us', 'hi'));

    // The lookup was asked twice (before the send and after `No LID for user`) and answered neither time.
    expect(getNumberId).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(RecipientUnreachableError);
    expect(outcome).toBeInstanceOf(EnginePageError);
    expect((outcome as EnginePageError).getStatus()).toBe(500);
    expect((outcome as Error).message).toContain('No LID for user');
  });

  // The send may not have gone out, but nothing proves it did not: a keyed send keeps its key, and the
  // pacing admission stays charged, exactly as for any other engine-stage send failure.
  it('leaves the outcome unproven for idempotency and pacing', async () => {
    const adapter = ready({
      getNumberId: jest.fn().mockRejectedValue(new Error('t: t')),
      sendMessage: jest.fn().mockRejectedValue(noLid()),
    });

    const outcome = await outcomeOf(adapter.sendTextMessage('628123456789@c.us', 'hi'));

    expect(outcome).not.toBeInstanceOf(RecipientUnreachableError);
    expect(sendFailureProvesNothingSent(markEngineSendFailure(outcome))).toBe(false);
    expect(sentNothing(outcome)).toBe(false);
  });

  // One recipient WhatsApp Web refused and could not look up says nothing about the account's standing, so a run
  // of them must not pause every send of the session. A page refusal of any other send still counts.
  it('does not count toward the send breaker, while another page refusal still does', async () => {
    const adapter = ready({
      getNumberId: jest.fn().mockRejectedValue(new Error('t: t')),
      sendMessage: jest
        .fn()
        .mockRejectedValueOnce(noLid())
        .mockRejectedValueOnce(new Error('page threw {"name":"TypeError","message":"x"}')),
    });

    const unanswered = await outcomeOf(adapter.sendTextMessage('628123456789@c.us', 'hi'));
    const refused = await outcomeOf(adapter.sendTextMessage('120363012345678901@g.us', 'hi'));

    expect(unanswered).toBeInstanceOf(EnginePageError);
    expect(countsTowardSendBreaker(unanswered)).toBe(false);
    expect(refused).toBeInstanceOf(EnginePageError);
    expect(countsTowardSendBreaker(refused)).toBe(true);
  });

  // Not counted, the send service logs no engine-failure line for it, so this warning is the one that has to name
  // the session the 500 came from.
  it('logs a warning naming the session and the chat', async () => {
    const adapter = ready({
      getNumberId: jest.fn().mockRejectedValue(new Error('t: t')),
      sendMessage: jest.fn().mockRejectedValue(noLid()),
    });
    const warn = jest.spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn');

    await outcomeOf(adapter.sendTextMessage('628123456789@c.us', 'hi'));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not answer'),
      expect.objectContaining({ sessionId: 's', chatId: '628123456789@c.us', error: 't: t' }),
    );
  });

  it('does not retry a cached id that went stale when the lookup that would replace it fails', async () => {
    const getNumberId = jest
      .fn()
      .mockResolvedValueOnce({ _serialized: '159442138038327@lid' })
      .mockRejectedValueOnce(new Error('t: t'));
    const sendMessage = jest.fn().mockResolvedValueOnce(sentMessage).mockRejectedValueOnce(noLid());
    const adapter = ready({ getNumberId, sendMessage });
    await adapter.sendTextMessage('628123456789@c.us', 'first');

    const outcome = await outcomeOf(adapter.sendTextMessage('628123456789@c.us', 'second'));

    expect(outcome).toBeInstanceOf(EnginePageError);
    expect(outcome).not.toBeInstanceOf(RecipientUnreachableError);
    // One send per request: the failed lookup offered nothing better to retry against.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith('159442138038327@lid', 'second');
  });

  // A reload that cut the lookup short before the window was stamped: the lookup itself answered the
  // retryable 409, and that is the answer the send gives too.
  it('passes through the not-ready answer of a lookup cut short by a page reload', async () => {
    const getNumberId = jest
      .fn()
      .mockRejectedValue(new Error('Execution context was destroyed, most likely because of a navigation.'));
    const sendMessage = jest.fn().mockRejectedValue(noLid());
    const adapter = ready({ getNumberId, sendMessage });

    const outcome = await outcomeOf(adapter.sendTextMessage('628123456789@c.us', 'hi'));

    expect(outcome).toBeInstanceOf(EngineNotReadyError);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // The verdict the 400 is for stays as it is: the lookup answered that the number resolves to nothing.
  it('is still reported as an unreachable recipient when the lookup answered null', async () => {
    const getNumberId = jest.fn().mockResolvedValue(null);
    const sendMessage = jest.fn().mockRejectedValue(noLid());
    const adapter = ready({ getNumberId, sendMessage });

    await expect(adapter.sendTextMessage('628123456789@c.us', 'hi')).rejects.toBeInstanceOf(RecipientUnreachableError);
  });
});
