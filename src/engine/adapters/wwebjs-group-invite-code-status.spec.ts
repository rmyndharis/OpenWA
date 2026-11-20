import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { readInviteCodeInPage } from './wwebjs-groups';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * whatsapp-web.js reads every rejection named `ServerStatusCodeError` of the invite code job as "no code", which the
 * adapter read as missing admin rights, so a rate limit or a server error, which only means the same request may pass
 * later, was a 403, and a refusal of the Mex class, which carries a status as well, was a bare 500. The code is now read
 * in the page and answers by the status WhatsApp gave: 503 for 423, 429 and 5xx, 403 for any other status. A page with
 * no job to read it with is the library's own call, as it was.
 */
describe('the group invite code read, answered by the status WhatsApp gave', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  const rejection = (name: string, status?: number, message = 'refused') =>
    Object.assign(new Error(message), { name, ...(status === undefined ? {} : { status }) });

  /**
   * A page whose invite code job is `job`, or has none; the page function runs as it does there. For a module the page
   * has not defined its `require` throws, as before the page's error setup has run, or answers `undefined`, as it does
   * from a page.evaluate on a booted page.
   */
  const adapterOnPage = (
    modules: Record<string, unknown>,
    getInviteCode = jest.fn().mockResolvedValue('FROMLIBRARY'),
    unknownModule: 'throws' | 'undefined' = 'throws',
  ) => {
    const chat = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {}, getInviteCode };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: {},
      getChatById: jest.fn().mockResolvedValue(chat),
      pupPage: {
        evaluate: jest.fn((fn: typeof readInviteCodeInPage, arg: string) => {
          g.window = {
            require: (name: string) => {
              if (!(name in modules)) {
                if (unknownModule === 'undefined') return undefined;
                throw new Error(`Requiring unknown module "${name}"`);
              }
              return modules[name];
            },
          };
          return Promise.resolve().then(() => fn(arg));
        }),
      },
    };
    return { adapter, getInviteCode };
  };
  const withJob = (fetchMexGroupInviteCode: jest.Mock) => ({
    WAWebMexFetchGroupInviteCodeJob: { fetchMexGroupInviteCode },
  });

  it.each([
    ['a code as a string', 'ABC123', 'ABC123'],
    ['a code in an object', { code: 'XYZ789' }, 'XYZ789'],
  ])('returns %s without the library call', async (_name, answer, code) => {
    const fetch = jest.fn().mockResolvedValue(answer);
    const { adapter, getInviteCode } = adapterOnPage(withJob(fetch));

    await expect(adapter.getGroupInviteCode(GROUP)).resolves.toBe(code);

    expect(fetch).toHaveBeenCalledWith(GROUP);
    expect(getInviteCode).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'a rate limit (429)', status: 429 },
    { name: 'a lock (423)', status: 423 },
    { name: 'a server error (500)', status: 500 },
    { name: 'an unavailable service (503)', status: 503 },
  ])('answers the retryable 503 for $name, in either class', async ({ status }) => {
    for (const name of ['ServerStatusCodeError', 'MexServerStatusCodeError']) {
      const { adapter } = adapterOnPage(withJob(jest.fn().mockRejectedValue(rejection(name, status))));

      await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineTransportError);
    }
  });

  it.each([
    { name: 'a refusal (403)', status: 403 },
    { name: 'a missing group (404)', status: 404 },
    { name: 'a bad request (400)', status: 400 },
    { name: 'a refusal that names no status', status: undefined },
  ])('answers the 403 for $name, in either class', async ({ status }) => {
    for (const name of ['ServerStatusCodeError', 'MexServerStatusCodeError']) {
      const { adapter } = adapterOnPage(withJob(jest.fn().mockRejectedValue(rejection(name, status))));

      await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineRefusedError);
    }
  });

  it('keeps the 403 of a job that gives no code', async () => {
    const { adapter } = adapterOnPage(withJob(jest.fn().mockResolvedValue(undefined)));

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineRefusedError);
  });

  // The job of build 2.3000.1054966512-alpha throws a plain Error, with no status, when WhatsApp answers with no code:
  // the same refusal as a job that resolves none, not a bare 500.
  it.each([
    ['the message of the job', '[MEX][GROUP] group invite code is null'],
    ['a message that carries more text', 'Error: [MEX][GROUP] group invite code is null (group 120363@g.us)'],
  ])('answers the 403 for the plain error of a read that gave no code: %s', async (_name, message) => {
    const failure = rejection('Error', undefined, message);
    const fetch = jest.fn().mockRejectedValue(failure);
    const { adapter, getInviteCode } = adapterOnPage(withJob(fetch));

    const error = await adapter.getGroupInviteCode(GROUP).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineRefusedError);
    expect((error as Error).message).toMatch(/admin rights required/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getInviteCode).not.toHaveBeenCalled();
  });

  it.each([
    ['another error of the job', 'something inside the job'],
    ['the same words without the group prefix', 'group invite code is null'],
    ['another read of the same family', '[MEX][GROUP] group metadata is null'],
  ])('leaves any other plain error as it was: %s', async (_name, message) => {
    const failure = rejection('Error', undefined, message);
    const { adapter } = adapterOnPage(withJob(jest.fn().mockRejectedValue(failure)));

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBe(failure);
  });

  it.each<[string, Record<string, unknown>, 'throws' | 'undefined']>([
    ['a build that has no such module, where require throws', {}, 'throws'],
    ['a build that has no such module, where require answers undefined', {}, 'undefined'],
    ['a module without the job', { WAWebMexFetchGroupInviteCodeJob: {} }, 'throws'],
  ])('runs the library call on %s', async (_name, modules, unknownModule) => {
    const { adapter, getInviteCode } = adapterOnPage(modules, undefined, unknownModule);

    await expect(adapter.getGroupInviteCode(GROUP)).resolves.toBe('FROMLIBRARY');

    expect(getInviteCode).toHaveBeenCalledTimes(1);
  });

  it('answers the 409 of a reload on a document that has no require yet', async () => {
    const { adapter, getInviteCode } = adapterOnPage({});
    const evaluate = (adapter as unknown as { client: { pupPage: { evaluate: jest.Mock } } }).client.pupPage.evaluate;
    evaluate.mockImplementation((fn: typeof readInviteCodeInPage, arg: string) => {
      g.window = {};
      return Promise.resolve().then(() => fn(arg));
    });

    await expect(adapter.getGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(getInviteCode).not.toHaveBeenCalled();
  });
});
