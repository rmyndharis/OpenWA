import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

// The library's own page code: the functions it ships into WhatsApp Web, which `LoadUtils` installs as `window.WWebJS`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils') as { LoadUtils: () => void };
const { Client } = wwebjs as unknown as { Client: { prototype: object } };

/**
 * The removal of the account's own profile picture is the request WhatsApp Web's picture job sends, and whatsapp-web.js
 * reads every status that job rejects with (`ServerStatusCodeError`) as `false`, which the adapter read as a refusal: a
 * rate limit, a timeout or a server error, which removed nothing and may pass a moment later, was a 403, where the
 * removal of a group's picture, which sends the same request, answered the retryable 503. The adapter now sends the
 * request in the page and answers by the status WhatsApp gave.
 *
 * The page below behaves as build 2.3000.1054966512-alpha does, read off its scripts: `requestDeletePicture` of
 * `WAWebContactProfilePicThumbBridge` resolves `{ status: 200 }` and rejects the `ServerStatusCodeError` of the job.
 * The client is the library's own, on top of the helpers it installs as `window.WWebJS`, so what is asserted is what the
 * adapter does there.
 */
describe('removing the account profile picture on whatsapp-web.js', () => {
  const OWN = '628000000001@c.us';
  const g = globalThis as unknown as { window?: Record<string, unknown> };

  afterEach(() => {
    delete g.window;
  });

  const statusError = (status: number) =>
    Object.assign(new Error(`status ${status}`), { name: 'ServerStatusCodeError', status, statusCode: status });

  interface Page {
    /** What the job does, by default resolving the 200 of a removal. */
    request?: jest.Mock;
    /** The page's own copy of the account's picture: `undefined` when it holds none, else what `canDelete()` says. */
    copy?: { canDelete: boolean } | undefined;
    /** Module names this build does not define. */
    without?: string[];
    /** What its `require` does for one: answer `undefined` (from a page.evaluate) or throw (before the page's error setup). */
    unknownModule?: 'throws' | 'undefined';
  }

  const installPage = (page: Page = {}) => {
    const requestDeletePicture = page.request ?? jest.fn().mockResolvedValue({ status: 200 });
    const copy = 'copy' in page ? page.copy : { canDelete: true };
    const modules: Record<string, unknown> = {
      WAWebWidFactory: { createWid: (id: string) => ({ _serialized: id }) },
      WAWebCollections: { ProfilePicThumb: { get: () => (copy ? { canDelete: () => copy.canDelete } : undefined) } },
      WAWebContactProfilePicThumbBridge: { requestDeletePicture },
    };
    for (const name of page.without ?? []) delete modules[name];
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) {
          if (page.unknownModule === 'undefined') return undefined;
          throw new Error(`Requiring unknown module "${name}"`);
        }
        return modules[name];
      },
    };
    LoadUtils();
    return requestDeletePicture;
  };

  const adapterOnThatPage = (info: unknown = { wid: { _serialized: OWN } }) => {
    const evaluate = jest.fn((fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve().then(() => fn(...args)),
    );
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = Object.assign(Object.create(Client.prototype) as object, {
      info,
      pupPage: { evaluate },
    });
    return { adapter, evaluate };
  };

  it('is done when WhatsApp accepts it, and the request names the account itself', async () => {
    const request = installPage();

    await expect(adapterOnThatPage().adapter.deleteProfilePicture()).resolves.toBeUndefined();
    expect(request.mock.calls).toEqual([[{ _serialized: OWN }]]);
  });

  // The route is documented as safe to repeat: the repeat is the same request, and WhatsApp's 200 settles it again.
  it('converges on a repeat, which is the same request again', async () => {
    const request = installPage();
    const { adapter } = adapterOnThatPage();

    await expect(adapter.deleteProfilePicture()).resolves.toBeUndefined();
    await expect(adapter.deleteProfilePicture()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 406])('is a refusal that names the status when WhatsApp answers %i', async status => {
    installPage({ request: jest.fn().mockRejectedValue(statusError(status)) });

    const attempt = adapterOnThatPage().adapter.deleteProfilePicture();

    await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`the engine rejected the profile picture removal \\(WhatsApp answered ${status}\\)`),
    );
  });

  // Nothing was removed and the request may pass later: a refusal here would tell a caller to give up.
  it.each([408, 423, 429, 500, 503])(
    'is a retryable failure, not a refusal, when WhatsApp answers %i',
    async status => {
      installPage({ request: jest.fn().mockRejectedValue(statusError(status)) });

      const attempt = adapterOnThatPage().adapter.deleteProfilePicture();

      await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
      await expect(attempt).rejects.toThrow(new RegExp(`answered ${status} .* removed nothing`));
    },
  );

  it('lets what is not a status from WhatsApp through', async () => {
    installPage({ request: jest.fn().mockRejectedValue(new Error('page closed')) });

    await expect(adapterOnThatPage().adapter.deleteProfilePicture()).rejects.toThrow('page closed');
  });

  // The library asks WhatsApp only when the page's own copy of the picture says the account has one, and dies reading a
  // copy the page does not hold. The request is the account's to make whatever the copy says, and WhatsApp decides.
  it.each([
    ['says the account has no picture', { canDelete: false }],
    ['is not held at all', undefined],
  ])('sends the request when the page copy of the picture %s', async (_case, copy) => {
    const request = installPage({ copy });

    await expect(adapterOnThatPage().adapter.deleteProfilePicture()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  // A build that lacks the job or the id factory: from a page.evaluate Meta's `require` answers `undefined` for a module
  // the page has not defined, and throws only inside a guard or before the page's error setup has run. Nothing is sent
  // either way.
  describe.each<[string, 'throws' | 'undefined']>([
    ['the module is not defined (require throws)', 'throws'],
    ['the module answers undefined', 'undefined'],
  ])('when %s', (_how, unknownModule) => {
    it.each(['WAWebContactProfilePicThumbBridge', 'WAWebWidFactory'])(
      'answers 501 without asking WhatsApp when %s is gone',
      async name => {
        const request = installPage({ without: [name], unknownModule });

        const attempt = adapterOnThatPage().adapter.deleteProfilePicture();

        await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
        await expect(attempt).rejects.toThrow(/deleteProfilePicture\(no picture delete job on this build\)/);
        expect(request).not.toHaveBeenCalled();
      },
    );
  });

  // The request is addressed by the id of the account itself, which a client that has not reported it yet does not have.
  it('answers the retryable 409 without asking the page when the client has not reported its own account id', async () => {
    installPage();
    const { adapter, evaluate } = adapterOnThatPage({});

    await expect(adapter.deleteProfilePicture()).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  // A document that has not defined `require` yet is a page that is reloading, not a build without the job.
  it('answers the retryable 409 for a page that is reloading', async () => {
    g.window = {};

    await expect(adapterOnThatPage().adapter.deleteProfilePicture()).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('answers the retryable 503 when the page does not answer in time', async () => {
    installPage();
    const { adapter, evaluate } = adapterOnThatPage();
    evaluate.mockRejectedValue(
      new Error(
        "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
      ),
    );

    await expect(adapter.deleteProfilePicture()).rejects.toBeInstanceOf(EngineTransportError);
  });
});
