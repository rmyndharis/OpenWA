import { BadRequestException } from '@nestjs/common';
import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';

const { Client } = wwebjs as unknown as { Client: { prototype: object } };

/**
 * Joining a group by invite code, and previewing one, are jobs of WhatsApp Web (`joinGroupViaInvite` of
 * `WAWebGroupInviteJob`, `queryGroupInvite` of `WAWebGroupQueryJob`) that reject `ServerStatusCodeError(status)` for
 * every answer that is not a success: a refused invite, a rate limit, a timeout and a server error alike. Puppeteer hands
 * a page error to Node without its status, so the adapter answered all of them as the invite being bad (a 400 for the
 * join, a 404 for the preview), where Baileys answers the retryable 503 for a rate limit or a timeout: a caller threw
 * away a good code that would have passed after a pause. The status is now read in the page.
 *
 * The page below behaves as build 2.3000.1054966512-alpha does, read off its scripts: the join sends the IQ and rejects
 * `ServerStatusCodeError(errorCode, text)` when the answer is an error, and `UnexpectedJoinGroupViaInviteResponse` when it
 * is the request that an admin has to approve; the preview rejects `ServerStatusCodeError(Number(code), text)` for the
 * client and server errors of its response. The client is the library's own, so on a build that has the jobs its calls
 * are what the adapter replaced.
 */
describe('a group invite that WhatsApp answers with a status', () => {
  const g = globalThis as unknown as { window?: unknown };
  const GID = '120363000000000001@g.us';

  afterEach(() => {
    delete g.window;
  });

  const statusError = (status: number, name = 'ServerStatusCodeError', message = `status ${status}`) =>
    Object.assign(new Error(message), { name, status, statusCode: status });

  const page = (modules: Record<string, unknown>) => {
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Requiring unknown module "${name}"`);
        return modules[name];
      },
    };
  };

  const adapterOnThatPage = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = Object.assign(Object.create(Client.prototype) as object, {
      pupPage: {
        evaluate: (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => Promise.resolve().then(() => fn(...a)),
      },
    });
    return adapter;
  };

  describe('the join', () => {
    const joinFailing = (error: Error) =>
      page({ WAWebGroupInviteJob: { joinGroupViaInvite: jest.fn().mockRejectedValue(error) } });

    it('gives the id of the group the job joined', async () => {
      page({ WAWebGroupInviteJob: { joinGroupViaInvite: jest.fn().mockResolvedValue({ gid: { _serialized: GID } }) } });

      await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).resolves.toBe(GID);
    });

    // Nothing was joined and the same code may pass a moment later: the retryable 503, as Baileys answers 408 and 429.
    it.each([408, 423, 429, 500, 503])(
      'is a retryable failure, not a bad invite, when WhatsApp answers %i',
      async status => {
        joinFailing(statusError(status));

        const attempt = adapterOnThatPage().joinGroupViaInviteCode('CODE');

        await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
        await expect(attempt).rejects.toThrow(new RegExp(`answered ${status} to the group join and joined nothing`));
      },
    );

    it('reads the class of a Mex job the same way', async () => {
      joinFailing(statusError(429, 'MexServerStatusCodeError'));

      await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(EngineTransportError);
    });

    it.each([400, 401, 403, 404, 406, 409, 410])(
      'is the 400 of a refused invite when WhatsApp answers %i',
      async status => {
        joinFailing(statusError(status));

        await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(InvalidInviteCodeError);
      },
    );

    it('is the 400 of a refused invite when the error carries no status', async () => {
      joinFailing(Object.assign(new Error('refused'), { name: 'ServerStatusCodeError' }));

      await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(InvalidInviteCodeError);
    });

    it('keeps the 400 for a failure that is no status of WhatsApp', async () => {
      joinFailing(new Error('something else broke'));

      await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(InvalidInviteCodeError);
    });

    it('still says a request to join was sent when the group has an admin approve new members', async () => {
      joinFailing(
        Object.assign(new Error(''), {
          name: 'UnexpectedJoinGroupViaInviteResponse',
          gid: { _serialized: GID },
          membershipApprovalMode: true,
        }),
      );

      const error = await adapterOnThatPage()
        .joinGroupViaInviteCode('CODE')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).not.toBeInstanceOf(InvalidInviteCodeError);
    });
  });

  describe('the preview', () => {
    const previewFailing = (error: Error) =>
      page({ WAWebGroupQueryJob: { queryGroupInvite: jest.fn().mockRejectedValue(error) } });

    it('reads what the job resolves', async () => {
      const queryGroupInvite = jest.fn().mockResolvedValue({ id: { _serialized: GID }, subject: 'Team', size: 3 });
      page({ WAWebGroupQueryJob: { queryGroupInvite } });

      await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).resolves.toEqual({
        id: GID,
        name: 'Team',
        participantCount: 3,
      });
      expect(queryGroupInvite.mock.calls).toEqual([['CODE']]);
    });

    // A read read nothing and the same code may pass a moment later: the retryable 503, as Baileys answers 408 and 429.
    it.each([408, 423, 429, 500, 503])(
      'is a retryable failure, not an unknown invite, when WhatsApp answers %i',
      async status => {
        previewFailing(statusError(status));

        const attempt = adapterOnThatPage().getGroupJoinInfo('CODE');

        await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
        await expect(attempt).rejects.toThrow(new RegExp(`answered ${status} to the preview of invite CODE`));
      },
    );

    it.each([400, 401, 403, 404, 406, 410])(
      'is the 404 of an unknown invite when WhatsApp answers %i',
      async status => {
        previewFailing(statusError(status));

        await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(GroupNotFoundError);
      },
    );

    it('is the 404 of an unknown invite when the error carries no status, or is no status at all', async () => {
      previewFailing(Object.assign(new Error('refused'), { name: 'ServerStatusCodeError' }));
      await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(GroupNotFoundError);

      previewFailing(new Error('invite revoked'));
      await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('is the 404 of an unknown invite when the answer names no group', async () => {
      page({ WAWebGroupQueryJob: { queryGroupInvite: jest.fn().mockResolvedValue({ subject: 'Team' }) } });

      await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    // The Mex job that a build runs for the preview makes up a 500 with no text at all when its query answers no group
    // and no error: an answer that holds no group, so the 404 of an unknown invite and no failure to retry.
    it('is the 404 of an unknown invite when the Mex job rejects a 500 with no text', async () => {
      previewFailing(statusError(500, 'ServerStatusCodeError', ''));

      await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    // A 500 that says anything is a failure like any other, and keeps the retryable 503.
    it('is still the retryable failure for a 500 with a text', async () => {
      previewFailing(statusError(500, 'ServerStatusCodeError', 'missing id in invite info participant'));

      const attempt = adapterOnThatPage().getGroupJoinInfo('CODE');

      await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
      await expect(attempt).rejects.toThrow(/answered 500 to the preview of invite CODE/);
    });

    // Only a 500 with an empty text is the shape that rule reads: any other status keeps what its status says.
    it.each([408, 423, 429, 502, 503])(
      'is still the retryable failure for the status %i with no text',
      async status => {
        previewFailing(statusError(status, 'ServerStatusCodeError', ''));

        const attempt = adapterOnThatPage().getGroupJoinInfo('CODE');

        await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
        await expect(attempt).rejects.toThrow(new RegExp(`answered ${status} to the preview of invite CODE`));
      },
    );

    // The text is read as written: whitespace, or no text at all, is a 500 that says something or nothing readable, and
    // not the empty answer of the query. Pinned as the retryable failure, as every 500 that is not that exact shape.
    it.each([
      ['a text of only spaces', statusError(500, 'ServerStatusCodeError', '  ')],
      ['a text of a newline', statusError(500, 'ServerStatusCodeError', '\n')],
      ['no text property', { name: 'ServerStatusCodeError', status: 500 }],
      ['a null text', { name: 'ServerStatusCodeError', status: 500, message: null }],
    ])('is still the retryable failure for a 500 with %s', async (_case, error) => {
      previewFailing(error as Error);

      const attempt = adapterOnThatPage().getGroupJoinInfo('CODE');

      await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
      await expect(attempt).rejects.toThrow(/answered 500 to the preview of invite CODE/);
    });
  });
});
