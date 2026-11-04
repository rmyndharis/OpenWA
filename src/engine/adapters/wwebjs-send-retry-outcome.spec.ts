import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus, type IWhatsAppEngine } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';

/**
 * A send to a contact WhatsApp has moved to privacy-id addressing fails with `No LID for user` on its phone id, and
 * the adapter then looks the recipient up again and retries. That page can throw after the message is already on the
 * wire, so whatever the adapter answers once the first attempt ran proves nothing about the message: a keyed send
 * keeps its Idempotency-Key and a paced bulk item or product send keeps its admission for the window. An answer
 * given before the first attempt is still proof that nothing left.
 */
describe('a whatsapp-web.js send whose first attempt failed with "No LID for user"', () => {
  const PHONE = '628123456789@c.us';
  const LID = '159442138038327@lid';
  const QUOTED = 'true_628123456789@c.us_QUOTED';

  const found = (id: string): { _serialized: string } => ({ _serialized: id });
  const noLid = (): Error => new Error('No LID for user');
  const outcomeOf = (send: Promise<unknown>): Promise<unknown> =>
    send.then(
      () => 'sent',
      (error: unknown) => error,
    );

  const build = (
    client: (setStatus: (status: EngineStatus) => void) => Record<string, unknown>,
  ): { adapter: WhatsAppWebJsAdapter; sendMessage: jest.Mock } => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    const setStatus = (status: EngineStatus): void => {
      (adapter as unknown as { status: EngineStatus }).status = status;
    };
    setStatus(EngineStatus.READY);
    const fake = client(setStatus);
    (adapter as unknown as { client: unknown }).client = fake;
    return { adapter, sendMessage: fake.sendMessage as jest.Mock };
  };

  type Case = {
    client: (setStatus: (status: EngineStatus) => void) => Record<string, unknown>;
    expected: new (...args: never[]) => Error;
    status: number;
    quoted?: boolean;
    sends: number;
  };

  const cases: Array<[string, Case]> = [
    [
      'the session leaves READY while the recipient is looked up again',
      {
        client: setStatus => ({
          getNumberId: jest
            .fn()
            .mockResolvedValueOnce(found(PHONE))
            .mockImplementationOnce(() => {
              setStatus(EngineStatus.DISCONNECTED);
              return Promise.resolve(found(LID));
            }),
          sendMessage: jest.fn().mockRejectedValue(noLid()),
        }),
        expected: EngineNotReadyError,
        status: 409,
        sends: 1,
      },
    ],
    [
      'a page reload cuts the second lookup short',
      {
        client: () => ({
          getNumberId: jest
            .fn()
            .mockResolvedValueOnce(found(PHONE))
            .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.')),
          sendMessage: jest.fn().mockRejectedValue(noLid()),
        }),
        expected: EngineNotReadyError,
        status: 409,
        sends: 1,
      },
    ],
    [
      'the second lookup names the same recipient again',
      {
        client: () => ({
          getNumberId: jest.fn().mockResolvedValue(null),
          sendMessage: jest.fn().mockRejectedValue(noLid()),
        }),
        expected: RecipientUnreachableError,
        status: 400,
        sends: 1,
      },
    ],
    [
      'the retry fails with "No LID for user" again',
      {
        client: () => ({
          getNumberId: jest.fn().mockResolvedValueOnce(found(PHONE)).mockResolvedValueOnce(found(LID)),
          sendMessage: jest.fn().mockRejectedValue(noLid()),
        }),
        expected: RecipientUnreachableError,
        status: 400,
        sends: 2,
      },
    ],
    [
      'the retry fails on the quoted message',
      {
        client: () => ({
          getNumberId: jest.fn().mockResolvedValueOnce(found(PHONE)).mockResolvedValueOnce(found(LID)),
          sendMessage: jest
            .fn()
            .mockRejectedValueOnce(noLid())
            .mockRejectedValueOnce(new Error('Evaluation failed: Error: Could not get the quoted message.')),
        }),
        expected: MessageNotFoundError,
        status: 404,
        quoted: true,
        sends: 2,
      },
    ],
  ];

  it.each(cases)('leaves the outcome unknown for a keyed send and a paced send when %s', async (_label, testCase) => {
    const { adapter, sendMessage } = build(testCase.client);

    const error = await outcomeOf(
      (adapter as IWhatsAppEngine).sendTextMessage(
        PHONE,
        'hi',
        undefined,
        testCase.quoted ? { quotedMessageId: QUOTED } : undefined,
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(testCase.sends);
    expect(error).toBeInstanceOf(testCase.expected);
    expect((error as { getStatus: () => number }).getStatus()).toBe(testCase.status);
    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(false);
    expect(sentNothing(error)).toBe(false);
    // The answer is the caller's or the engine state's, not the account's: the send breaker still ignores it.
    expect(countsTowardSendBreaker(error)).toBe(false);
  });

  // Known-negative controls: what the adapter answers before it has attempted the send still hands everything back.
  it('still hands the admission back for a session that was not ready before the first attempt', async () => {
    const { adapter, sendMessage } = build(setStatus => {
      setStatus(EngineStatus.DISCONNECTED);
      return { getNumberId: jest.fn(), sendMessage: jest.fn() };
    });

    const error = await outcomeOf(adapter.sendTextMessage(PHONE, 'hi'));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(true);
    expect(sentNothing(error)).toBe(true);
  });

  it('still hands the admission back for a quoted message the page cannot resolve on the first attempt', async () => {
    const { adapter, sendMessage } = build(() => ({
      getNumberId: jest.fn().mockResolvedValue(found(PHONE)),
      sendMessage: jest
        .fn()
        .mockRejectedValue(new Error('Evaluation failed: Error: Could not get the quoted message.')),
    }));

    const error = await outcomeOf(
      (adapter as IWhatsAppEngine).sendTextMessage(PHONE, 'hi', undefined, { quotedMessageId: QUOTED }),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(MessageNotFoundError);
    expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(true);
    expect(sentNothing(error)).toBe(true);
  });
});
