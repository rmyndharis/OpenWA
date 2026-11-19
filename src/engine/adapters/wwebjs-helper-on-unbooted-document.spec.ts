import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { deleteGroupPictureInPage, readInviteSenderInPage, revokeInviteInPage } from './wwebjs-groups';
import { readCurrentLid, readLeanContacts } from './wwebjs-contacts';
import { readChatModels } from './wwebjs-chats';
import { readLabelChatIds } from './wwebjs-labels';
import { downloadMediaInPage } from './wwebjs-messaging';
import { readStatusSetterInPage } from './wwebjs-profile';
import { runWriteInPage } from './wwebjs-page-writes';
import { isNavigationError } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

/**
 * A page call can land on the document a reload has just opened, before WhatsApp Web has booted and defined
 * `window.require`: Puppeteer holds a call made after the old context was cleared until the new one exists, and the
 * adapter stamps the reload only when it hears `framenavigated`, which comes later. Such a call died on the missing
 * function and was a bare 500, where a reload answers the retryable 409. The classifier reads the failure by the text
 * V8 gives it, `window.require is not a function` for the library's page functions. The page functions this adapter
 * ships itself read `require` through a local alias of the window, so V8 names the alias instead, `w.require is not a
 * function`.
 */
describe('a page helper that lands on a document WhatsApp Web has not booted yet', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  /** Run the page function the way Puppeteer does, on a document that has no `window.require` yet. */
  const evaluateOnUnbootedDocument = (fn: (arg?: unknown) => unknown, arg?: unknown): Promise<unknown> => {
    g.window = {};
    return Promise.resolve().then(() => fn(arg));
  };

  const ready = (evaluate: (fn: (arg?: unknown) => unknown, arg?: unknown) => Promise<unknown>) => {
    const chat = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {} };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: { wid: { _serialized: '628000000001@c.us', user: '628000000001' } },
      getChatById: jest.fn().mockResolvedValue(chat),
      pupPage: { evaluate: jest.fn(evaluate) },
    };
    return adapter;
  };

  // Every page function this adapter ships whose first access is `require`. The ones that start from
  // `window.WWebJS` instead (the local chat labels read) fail with a different text, which no wording of the
  // classifier can tell from an ordinary error of the page's own.
  const HELPERS = [
    ['deleteGroupPictureInPage', deleteGroupPictureInPage, GROUP],
    ['revokeInviteInPage', revokeInviteInPage, GROUP],
    ['readInviteSenderInPage', readInviteSenderInPage, undefined],
    ['readStatusSetterInPage', readStatusSetterInPage, undefined],
    ['readLeanContacts', readLeanContacts, undefined],
    ['readCurrentLid', readCurrentLid, '628111@c.us'],
    ['readChatModels', readChatModels, undefined],
    ['readLabelChatIds', readLabelChatIds, '7'],
    ['downloadMediaInPage', downloadMediaInPage, { msgId: 'm', maxBytes: 1 }],
    ['runWriteInPage, a subject', runWriteInPage, { kind: 'subject', chatId: GROUP, subject: 's' }],
    ['runWriteInPage, a description', runWriteInPage, { kind: 'description', chatId: GROUP, description: 'd' }],
    ['runWriteInPage, a picture', runWriteInPage, { kind: 'picture', chatId: GROUP, picture: {} }],
    ['runWriteInPage, a property', runWriteInPage, { kind: 'property', chatId: GROUP, property: 'restrict', value: 1 }],
  ] as Array<[string, (arg?: unknown) => unknown, unknown]>;

  it.each(HELPERS)(
    '%s fails on a document without window.require as a reload, not as an ordinary error',
    async (_name, helper, arg) => {
      const failure = await evaluateOnUnbootedDocument(helper, arg).then(
        () => undefined,
        (error: Error) => error,
      );

      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toMatch(/^(window|w)\.require is not a function$/);
      expect(isNavigationError(failure)).toBe(true);
    },
  );

  it.each([
    ['the group picture delete', (adapter: WhatsAppWebJsAdapter) => adapter.deleteGroupPicture(GROUP)],
    ['the contact list', (adapter: WhatsAppWebJsAdapter) => adapter.getContacts()],
    ['the chat list', (adapter: WhatsAppWebJsAdapter) => adapter.getChats()],
  ])('%s answers the retryable 409 of a reload, not a bare 500', async (_name, call) => {
    const adapter = ready(evaluateOnUnbootedDocument);

    await expect(call(adapter)).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('answers the same 409 for the library spelling, which is already read as a reload', async () => {
    const adapter = ready(() => Promise.reject(new TypeError('window.require is not a function')));

    await expect(adapter.deleteGroupPicture(GROUP)).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
