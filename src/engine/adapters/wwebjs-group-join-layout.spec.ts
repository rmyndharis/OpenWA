import { BadRequestException } from '@nestjs/common';
import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';

const { Client } = wwebjs as unknown as { Client: { prototype: object } };

/**
 * Joining a group by invite code runs `joinGroupViaInvite` of WhatsApp Web's `WAWebGroupInviteJob`. A build that does
 * not define the module made the library's call die in the page with a TypeError, which the adapter read as a refused
 * invite: every valid link was answered 400 "invalid, expired or revoked". The adapter now looks the job up first and
 * answers 501 where there is none, as the revoke and the invite code read of the same builds do.
 *
 * The job below is what build 2.3000.1054966512-alpha exports: `joinGroupViaInvite(code, requestsApproval, gid)`
 * resolves `{ gid }` for a join, rejects `ServerStatusCodeError(status)` when WhatsApp refuses the invite, and rejects
 * `UnexpectedJoinGroupViaInviteResponse` (with `membershipApprovalMode` true) when the group answers the invite with a
 * request that an admin has to approve. Meta's `require` throws for a module a build does not define, and answers
 * `undefined` from a page.evaluate with no guard active; both are run. The client is the library's own, so on a build
 * that has the job its `acceptInvite` is what the old call ran.
 */
describe('joining a group by invite code on each WhatsApp Web layout', () => {
  const g = globalThis as unknown as { window?: unknown };
  const GID = '120363000000000001@g.us';

  afterEach(() => {
    delete g.window;
  });

  const page = (modules: Record<string, unknown>, answerUndefined = false) => {
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) {
          if (answerUndefined) return undefined;
          throw new Error(`Requiring unknown module "${name}"`);
        }
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

  const withJob = (join: jest.Mock) => ({
    WAWebGroupInviteJob: { resetGroupInviteCode: jest.fn(), joinGroupViaInvite: join },
  });
  const refusal = (status: number) =>
    Object.assign(new Error(`status ${status}`), { name: 'ServerStatusCodeError', status });

  it('gives the id of the group the job joined, calling the job with the code alone', async () => {
    const join = jest.fn().mockResolvedValue({ gid: { _serialized: GID, user: '120363000000000001' } });
    page(withJob(join));

    await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).resolves.toBe(GID);
    expect(join.mock.calls).toEqual([['CODE']]);
  });

  it('reads the id of a build that renamed the property', async () => {
    page(withJob(jest.fn().mockResolvedValue({ gid: { $1: GID } })));

    await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).resolves.toBe(GID);
  });

  it.each([
    ['the module is not defined (require throws)', {}, false],
    ['the module answers undefined', {}, true],
    ['the module has no join job', { WAWebGroupInviteJob: { resetGroupInviteCode: jest.fn() } }, false],
  ])('answers 501 when %s, before anything is asked of WhatsApp', async (_case, modules, answerUndefined) => {
    page(modules, answerUndefined);

    const attempt = adapterOnThatPage().joinGroupViaInviteCode('CODE');

    await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
    await expect(attempt).rejects.toThrow(/joinGroupViaInviteCode\(no join job on this build\)/);
  });

  it('keeps the 400 of a refused invite', async () => {
    page(withJob(jest.fn().mockRejectedValue(refusal(403))));

    await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(InvalidInviteCodeError);
  });

  it('keeps the 400 of a result with no group id', async () => {
    page(withJob(jest.fn().mockResolvedValue({})));

    await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(InvalidInviteCodeError);
  });

  it('says a request to join was sent when the group has an admin approve new members', async () => {
    const requested = Object.assign(new Error(''), {
      name: 'UnexpectedJoinGroupViaInviteResponse',
      gid: { _serialized: GID },
      membershipApprovalMode: true,
    });
    page(withJob(jest.fn().mockRejectedValue(requested)));

    const error = await adapterOnThatPage()
      .joinGroupViaInviteCode('CODE')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).not.toBeInstanceOf(InvalidInviteCodeError);
    expect((error as Error).message).toMatch(/needs an admin to approve new members, and a request to join was sent/);
  });

  it('does not read the same error class without the request as an accepted invite', async () => {
    const other = Object.assign(new Error(''), {
      name: 'UnexpectedJoinGroupViaInviteResponse',
      membershipApprovalMode: false,
    });
    page(withJob(jest.fn().mockRejectedValue(other)));

    await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(InvalidInviteCodeError);
  });

  // A document that has not defined `require` yet is a page that is reloading, not a build without the job.
  it('answers the unknown-outcome 503 for a document without require, as for any reload during the join', async () => {
    g.window = {};

    await expect(adapterOnThatPage().joinGroupViaInviteCode('CODE')).rejects.toBeInstanceOf(EngineTransportError);
  });
});
