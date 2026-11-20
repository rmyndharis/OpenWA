import { NotFoundException } from '@nestjs/common';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { revokeInviteInPage } from './wwebjs-groups';
import { CAPTURED_PAGE_ERROR_PREFIX, PAGE_RELOADING_MESSAGE, isMissingRequireError } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

/**
 * The revoke rotates the invite code, so it does not converge when repeated and keeps the raw error of a failure that
 * leaves its outcome unknown. Its page function reads `require` as its first statement, though: on a document WhatsApp
 * Web has not booted yet that read is the failure, before anything was asked of WhatsApp, and the code was not rotated.
 * That one failure is the retryable 409 of a reload. A context destroyed while the call ran, or a function a build
 * dropped, is not.
 */
describe('the invite code revoke on a page that is reloading', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  const adapterAsking = (answer: (fn: unknown) => Promise<unknown>) => {
    const chat = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {} };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: {},
      getChatById: jest.fn().mockResolvedValue(chat),
      pupPage: { evaluate: jest.fn(answer) },
    };
    return adapter;
  };

  it('answers 409 on a document that has no require yet', async () => {
    const adapter = adapterAsking(fn => {
      g.window = {};
      return Promise.resolve().then(() => (fn as typeof revokeInviteInPage)(GROUP));
    });

    const call = adapter.revokeGroupInviteCode(GROUP);

    await expect(call).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(call).rejects.toMatchObject({
      message: PAGE_RELOADING_MESSAGE,
      response: { code: 'ENGINE_PAGE_RELOADING', retryAfterSeconds: 5 },
    });
  });

  it.each([
    ['a context destroyed while the call ran', 'Execution context was destroyed, most likely because of a navigation.'],
    [
      'a function a build dropped',
      'Evaluation failed: TypeError: w.require(...).resetGroupInviteCode is not a function',
    ],
    [
      'a protocol timeout',
      "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls",
    ],
  ])('keeps the raw error for %s', async (_name, message) => {
    const failure = new Error(message);

    await expect(adapterAsking(() => Promise.reject(failure)).revokeGroupInviteCode(GROUP)).rejects.toBe(failure);
  });

  it.each([
    {
      name: 'the alias of the page functions this adapter ships',
      error: new TypeError('w.require is not a function'),
      missing: true,
    },
    { name: 'the library spelling', error: new TypeError('window.require is not a function'), missing: true },
    {
      name: 'a function of the module a build dropped',
      error: new TypeError('w.require(...).resetGroupInviteCode is not a function'),
      missing: false,
    },
    { name: 'a context destroyed', error: new Error('Execution context was destroyed'), missing: false },
    {
      name: 'an error this application built',
      error: new NotFoundException('w.require is not a function'),
      missing: false,
    },
    {
      name: 'a failure captured inside the page',
      error: new Error(`${CAPTURED_PAGE_ERROR_PREFIX}{"message":"w.require is not a function"}`),
      missing: false,
    },
  ])('$name is read as a missing require: $missing', ({ error, missing }) => {
    expect(isMissingRequireError(error)).toBe(missing);
  });
});
