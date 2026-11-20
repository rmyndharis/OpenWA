import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

const { GroupChat } = wwebjs as unknown as { GroupChat: new (client: unknown, data: unknown) => unknown };

/**
 * A participant whose privacy settings allow joining only by invitation is answered 403 by WhatsApp, and
 * `GroupChat.addParticipants` of whatsapp-web.js then sends them a private group invite through
 * `WAWebChatSendMessages.sendGroupInviteMessage`. The build the gateway selects today exports that function from
 * `WAWebChatSendGroupInviteMessage` instead (as one options object, where the library passes positional arguments), so the
 * library's call was a TypeError inside its per-participant loop: the whole batch answered a bare 500 with the
 * participants before it already added and the ones after it never tried. The adapter now asks the page whether the
 * library's sender exists, and where it does not it adds the participants without the invitation, so the one that needs
 * it is a per-participant 403 and everyone else keeps their own outcome.
 *
 * The page below is built from the exports of build 2.3000.1054966512-alpha (read off its scripts): `WAWebChatSendMessages`
 * has no `sendGroupInviteMessage`, while the earlier layout has it. The library's own `GroupChat.addParticipants` runs
 * against it, so what is asserted is what that code does.
 */
describe('adding participants who can only be invited, on each WhatsApp Web layout', () => {
  const GROUP = '120363000000000001@g.us';
  const ADDED = '628111000001@c.us';
  const INVITE_ONLY = '628111000002@c.us';
  const UNREGISTERED = '628111000003@c.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  /**
   * `unknownModule` is what the page's `require` does for a module it has not defined: from a page.evaluate it answers
   * `undefined`, and it throws only inside a guard or before the page's error setup has run.
   */
  type Layout = {
    sendMessagesModule: Record<string, unknown> | 'undefined-module';
    unknownModule?: 'throws' | 'undefined';
  };
  /** WAWebChatSendMessages on the pinned build: four functions, none of them the invitation sender. */
  const pinnedSendMessages = () => ({
    sendDismissChangeNumber: jest.fn(),
    sendStarMsgs: jest.fn(),
    sendRevokeMsgs: jest.fn(),
    sendDeleteMsgs: jest.fn(),
  });

  const pageWith = (layout: Layout) => {
    const group = {
      id: { _serialized: GROUP },
      name: 'Test group',
      formattedTitle: 'Test group',
      iAmAdmin: () => true,
      groupMetadata: { participants: { serialize: () => [] as unknown[] } },
    };
    const wid = (id: string) => ({ _serialized: id, server: id.split('@')[1], user: id.split('@')[0] });
    const modules: Record<string, unknown> = {
      WAWebWidFactory: { createWid: wid },
      WAWebCollections: {
        Chat: { get: () => group, find: () => Promise.resolve(group) },
        Contact: { gadd: jest.fn() },
      },
      WAWebGroupQueryJob: { queryAndUpdateGroupMetadataById: jest.fn().mockResolvedValue(undefined) },
      WAWebQueryExistsJob: {
        queryWidExists: (w: { _serialized: string }) =>
          Promise.resolve(w._serialized === UNREGISTERED ? {} : { wid: w }),
      },
    };
    if (layout.sendMessagesModule !== 'undefined-module') modules.WAWebChatSendMessages = layout.sendMessagesModule;
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) {
          if (layout.unknownModule === 'undefined') return undefined;
          throw new Error(`Requiring unknown module "${name}"`);
        }
        return modules[name];
      },
      WWebJS: {
        getAddParticipantsRpcResult: (_group: unknown, w: { _serialized: string }) =>
          Promise.resolve(
            w._serialized === INVITE_ONLY
              ? {
                  code: 403,
                  name: 'ParticipantRequestCodeCanBeSent',
                  inviteV4Code: 'INVITECODE',
                  inviteV4CodeExp: '1999999999',
                }
              : { code: 200, name: 'ParticipantAdded' },
          ),
        getChat: (id: string) => Promise.resolve({ id: wid(id) }),
        getProfilePicThumbToBase64: () => Promise.resolve('THUMB'),
      },
    };
  };

  const adapterOnThatPage = () => {
    const evaluate = (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve().then(() => fn(...args));
    const client = { info: { wid: { _serialized: '628000000001@c.us', user: '628000000001' } }, pupPage: { evaluate } };
    const chat = new GroupChat(client, {
      id: { server: 'g.us', user: '120363000000000001', _serialized: GROUP },
      name: 'Test group',
      isGroup: true,
      groupMetadata: { participants: [], owner: { _serialized: '628000000001@c.us' }, creation: 1, desc: '' },
    }) as { addParticipants: (...args: unknown[]) => unknown };
    const libraryAdd = jest.spyOn(chat, 'addParticipants');
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = Object.assign(client, {
      getChatById: jest.fn().mockResolvedValue(chat),
    });
    return { adapter, libraryAdd };
  };

  describe('on the pinned build, whose WAWebChatSendMessages has no sendGroupInviteMessage', () => {
    it('adds the others and reports the one that needs an invitation as a 403, with no invite sent', async () => {
      pageWith({ sendMessagesModule: pinnedSendMessages() });

      const results = await adapterOnThatPage().adapter.addParticipants(GROUP, [ADDED, INVITE_ONLY, UNREGISTERED]);

      expect(results).toEqual([
        { id: ADDED, success: true, status: 200, message: 'The participant was added successfully' },
        {
          id: INVITE_ONLY,
          success: false,
          status: 403,
          message: 'The participant can be added by sending private invitation only',
        },
        { id: UNREGISTERED, success: false, status: 404, message: 'The phone number is not registered on WhatsApp' },
      ]);
    });

    it('answers a 403 refusal when the only participant needs an invitation', async () => {
      pageWith({ sendMessagesModule: pinnedSendMessages() });

      const attempt = adapterOnThatPage().adapter.addParticipants(GROUP, [INVITE_ONLY]);

      await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
      await expect(attempt).rejects.toThrow(`${INVITE_ONLY} (403)`);
    });

    it.each<['throws' | 'undefined']>([['throws'], ['undefined']])(
      'does the same when the module is not defined at all and require %s for it',
      async unknownModule => {
        pageWith({ sendMessagesModule: 'undefined-module', unknownModule });

        const results = await adapterOnThatPage().adapter.addParticipants(GROUP, [ADDED, INVITE_ONLY]);

        expect(results.map(r => [r.id, r.success, r.status])).toEqual([
          [ADDED, true, 200],
          [INVITE_ONLY, false, 403],
        ]);
      },
    );
  });

  describe('on an earlier layout, whose WAWebChatSendMessages has sendGroupInviteMessage', () => {
    it('sends the invitation with the library arguments and reports it as sent', async () => {
      const sendGroupInviteMessage = jest.fn().mockResolvedValue({ messageSendResult: 'OK' });
      pageWith({ sendMessagesModule: { ...pinnedSendMessages(), sendGroupInviteMessage } });

      const results = await adapterOnThatPage().adapter.addParticipants(GROUP, [ADDED, INVITE_ONLY]);

      expect(sendGroupInviteMessage).toHaveBeenCalledTimes(1);
      const [userChat, ...rest] = sendGroupInviteMessage.mock.calls[0] as [
        { id: { _serialized: string } },
        ...unknown[],
      ];
      expect(userChat.id._serialized).toBe(INVITE_ONLY);
      expect(rest).toEqual([GROUP, 'Test group', 'INVITECODE', '1999999999', '', 'THUMB']);
      expect(results.map(r => [r.id, r.success, r.status])).toEqual([
        [ADDED, true, 200],
        [INVITE_ONLY, true, 403],
      ]);
      expect(results[1].message).toMatch(/invite sent/);
    });

    it('keeps the 403 of an invitation the sender could not deliver', async () => {
      const sendGroupInviteMessage = jest.fn().mockResolvedValue({ messageSendResult: 'ERROR_UNKNOWN' });
      pageWith({ sendMessagesModule: { ...pinnedSendMessages(), sendGroupInviteMessage } });

      const results = await adapterOnThatPage().adapter.addParticipants(GROUP, [ADDED, INVITE_ONLY]);

      expect(results.map(r => [r.id, r.success, r.status])).toEqual([
        [ADDED, true, 200],
        [INVITE_ONLY, false, 403],
      ]);
    });
  });

  // A document that has not defined `require` yet is a page that is reloading: the question about the sender cannot be
  // answered, which must not read as "this build has no sender" and carry on to an add without invitations. The question
  // is a read made before anything is sent, so the reload is the retryable 409, as it is for the lookup before it.
  it('does not go on to the add when the page has no require to ask', async () => {
    g.window = {};
    const { adapter, libraryAdd } = adapterOnThatPage();

    await expect(adapter.addParticipants(GROUP, [ADDED])).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(libraryAdd).not.toHaveBeenCalled();
  });
});
