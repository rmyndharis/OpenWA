import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { revokeInviteInPage } from './wwebjs-groups';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

/**
 * Revoking a group's invite code asks WhatsApp Web's own request job for a new one, and the job has moved between
 * WhatsApp Web builds: `resetGroupInviteCode` was exported by `WAWebGroupQueryJob`, and the build the gateway selects
 * today exports it from `WAWebGroupInviteJob` (whose `WAWebGroupQueryJob` has no such member). The adapter runs the job
 * IN the page, so a build that moved it must still give the new code, a build that did not must keep working, and a
 * build with neither must answer 501, never a bare 500 from a missing function.
 *
 * The module exports below are those of build 2.3000.1054966512-alpha, read off its scripts. From a page.evaluate
 * Meta's `require` answers `undefined` for a module the page has not defined, and throws only inside a guard or before
 * the page's error setup has run; the registry here does either, and throws unless told to answer `undefined`.
 */
describe('revoking the invite code of a group on each WhatsApp Web layout', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  const widFactory = { createWid: (id: string) => ({ _serialized: id }) };
  /** WAWebGroupQueryJob on the pinned build: five exports, none of them the reset job. */
  const queryJobWithoutReset = () => ({
    queryAllGroups: jest.fn(),
    queryGroupInvite: jest.fn(),
    queryAndUpdateGroupMetadataById: jest.fn(),
    maybeQueryAndUpdateMembershipApprovalRequests: jest.fn(),
    queryGroupsById_DO_NOT_USE_DIRECTLY: jest.fn(),
  });
  const inviteJob = (reset: jest.Mock) => ({ resetGroupInviteCode: reset, joinGroupViaInvite: jest.fn() });

  const pageWith = (modules: Record<string, unknown>, unknownModule: 'throws' | 'undefined' = 'throws') => {
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) {
          if (unknownModule === 'undefined') return undefined;
          throw new Error(`Requiring unknown module "${name}"`);
        }
        return modules[name];
      },
    };
  };

  const adapterOnThatPage = () => {
    const chat = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {} };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: { wid: { _serialized: '628000000001@c.us', user: '628000000001' } },
      getChatById: jest.fn().mockResolvedValue(chat),
      pupPage: { evaluate: (fn: (arg: string) => unknown, arg: string) => Promise.resolve().then(() => fn(arg)) },
    };
    return adapter;
  };

  const refusal = () => Object.assign(new Error('status 403'), { name: 'ServerStatusCodeError', status: 403 });

  it('gives the new code when the job is in WAWebGroupInviteJob, as on the pinned build', async () => {
    const reset = jest.fn().mockResolvedValue({ code: 'NEWCODE' });
    pageWith({
      WAWebWidFactory: widFactory,
      WAWebGroupQueryJob: queryJobWithoutReset(),
      WAWebGroupInviteJob: inviteJob(reset),
    });

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).resolves.toBe('NEWCODE');
    expect(reset).toHaveBeenCalledWith({ _serialized: GROUP });
  });

  it('gives the new code when the job is still in WAWebGroupQueryJob and WAWebGroupInviteJob is not defined', async () => {
    const reset = jest.fn().mockResolvedValue({ code: 'OLDCODE' });
    pageWith({
      WAWebWidFactory: widFactory,
      WAWebGroupQueryJob: { ...queryJobWithoutReset(), resetGroupInviteCode: reset },
    });

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).resolves.toBe('OLDCODE');
    expect(reset).toHaveBeenCalledWith({ _serialized: GROUP });
  });

  it('asks WAWebGroupInviteJob when both modules have the job', async () => {
    const inInvite = jest.fn().mockResolvedValue({ code: 'FROMINVITE' });
    const inQuery = jest.fn().mockResolvedValue({ code: 'FROMQUERY' });
    pageWith({
      WAWebWidFactory: widFactory,
      WAWebGroupQueryJob: { ...queryJobWithoutReset(), resetGroupInviteCode: inQuery },
      WAWebGroupInviteJob: inviteJob(inInvite),
    });

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).resolves.toBe('FROMINVITE');
    expect(inQuery).not.toHaveBeenCalled();
  });

  it.each([
    [
      'both modules are defined without the job',
      { WAWebGroupQueryJob: queryJobWithoutReset(), WAWebGroupInviteJob: {} },
    ],
    ['neither module is defined', {}],
    ['only WAWebGroupQueryJob is defined, without the job', { WAWebGroupQueryJob: queryJobWithoutReset() }],
  ])('answers 501 when %s', async (_case, modules) => {
    pageWith({ WAWebWidFactory: widFactory, ...modules });

    const attempt = adapterOnThatPage().revokeGroupInviteCode(GROUP);
    await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
    await expect(attempt).rejects.toThrow(/revokeGroupInviteCode\(no reset job on this build\)/);
  });

  // The shape of a booted page: a module it has not defined answers `undefined`.
  it('gives the new code from WAWebGroupQueryJob when require answers undefined for WAWebGroupInviteJob', async () => {
    const reset = jest.fn().mockResolvedValue({ code: 'OLDCODE' });
    pageWith(
      { WAWebWidFactory: widFactory, WAWebGroupQueryJob: { ...queryJobWithoutReset(), resetGroupInviteCode: reset } },
      'undefined',
    );

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).resolves.toBe('OLDCODE');
  });

  it('answers 501 when require answers undefined for both modules', async () => {
    pageWith({ WAWebWidFactory: widFactory }, 'undefined');

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  it.each([
    [
      'WAWebGroupInviteJob',
      (reset: jest.Mock) => ({ WAWebGroupQueryJob: queryJobWithoutReset(), WAWebGroupInviteJob: inviteJob(reset) }),
    ],
    ['WAWebGroupQueryJob', (reset: jest.Mock) => ({ WAWebGroupQueryJob: { resetGroupInviteCode: reset } })],
  ])('keeps the 403 of a refusal from the job in %s', async (_where, modules) => {
    pageWith({ WAWebWidFactory: widFactory, ...modules(jest.fn().mockRejectedValue(refusal())) });

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('keeps any other failure of the job as it was', async () => {
    const failure = new TypeError('something inside the job');
    pageWith({
      WAWebWidFactory: widFactory,
      WAWebGroupInviteJob: inviteJob(jest.fn().mockRejectedValue(failure)),
    });

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).rejects.toBe(failure);
  });

  // A document that has not defined `require` yet is a page that is reloading, which the adapter answers with the
  // retryable 409 where it can tell: it must not be read as a build without the job.
  it('lets the failure of a document without require through, as it is not a build without the job', async () => {
    g.window = {};

    await expect(revokeInviteInPage(GROUP)).rejects.toThrow('w.require is not a function');
  });
});
