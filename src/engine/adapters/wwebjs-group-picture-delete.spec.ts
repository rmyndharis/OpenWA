import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { deleteGroupPictureInPage } from './wwebjs-groups';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * The delete of a group picture is sent to WhatsApp by the adapter itself and answered by WhatsApp's status.
 * `GroupChat.deletePicture` sends the request only when the page's own copy of the picture allows it and reads
 * every refusal as `false`, which left three wrong answers: a picture the page had not loaded was never deleted, a
 * repeat of a delete read as missing admin rights, and a rate limit or a server error read as a refusal. On a live
 * session WhatsApp answers 200 for a group with no picture as for one it removed, and now and then 500 for a delete
 * that follows a change closely.
 */
describe('whatsapp-web.js delete of a group picture', () => {
  const GROUP = '120363000000000001@g.us';
  const TIMEOUT = new Error(
    "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
  );

  function setup(answer: number | Error) {
    // The library's own delete must not be what decides: it answers nothing for a picture the page never loaded.
    const deletePicture = jest.fn().mockResolvedValue(undefined);
    const chat = { id: { _serialized: GROUP }, isGroup: true, participants: [], groupMetadata: {}, deletePicture };
    const evaluate = jest.fn((step: unknown, id: string) => {
      if (step !== deleteGroupPictureInPage || id !== GROUP) throw new Error('unexpected page call');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    });
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: { wid: { _serialized: '628000000001@c.us', user: '628000000001' } },
      getChatById: jest.fn().mockResolvedValue(chat),
      pupPage: { evaluate },
    };
    return { adapter, deletePicture, evaluate };
  }

  it('succeeds on the 200 WhatsApp gives for a picture it removed and for a group that had none', async () => {
    const { adapter, deletePicture, evaluate } = setup(200);

    await expect(adapter.deleteGroupPicture(GROUP)).resolves.toBeUndefined();
    // A repeat is the same request with the same answer.
    await expect(adapter.deleteGroupPicture(GROUP)).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(deletePicture).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 406])('is a refusal that names the status when WhatsApp answers %i', async status => {
    const { adapter } = setup(status);

    const attempt = adapter.deleteGroupPicture(GROUP);
    await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
    await expect(attempt).rejects.toThrow(new RegExp(`refused it \\(${status}\\), as when admin rights are required`));
  });

  // Nothing was deleted and the request may pass later: a refusal here would tell an admin to get admin rights.
  it.each([423, 429, 500, 503])('is a retryable failure, not a refusal, when WhatsApp answers %i', async status => {
    const { adapter } = setup(status);

    const attempt = adapter.deleteGroupPicture(GROUP);
    await expect(attempt).rejects.toBeInstanceOf(EngineTransportError);
    await expect(attempt).rejects.toThrow(new RegExp(`answered ${status} .* removed nothing`));
  });

  it('is a retryable failure when WhatsApp Web does not answer in time', async () => {
    const { adapter } = setup(TIMEOUT);

    await expect(adapter.deleteGroupPicture(GROUP)).rejects.toBeInstanceOf(EngineTransportError);
  });
});

describe('the in-page delete of a group picture', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => {
    delete g.window;
  });
  const page = (requestDeletePicture: jest.Mock) => {
    const modules: Record<string, unknown> = {
      WAWebWidFactory: { createWid: (id: string) => ({ _serialized: id }) },
      WAWebContactProfilePicThumbBridge: { requestDeletePicture },
    };
    g.window = { require: (name: string) => modules[name] };
  };
  const refusal = (status: unknown) =>
    Object.assign(new Error(`status ${String(status)}`), { name: 'ServerStatusCodeError', status });

  it('answers 200 when WhatsApp accepted the request', async () => {
    const requestDeletePicture = jest.fn().mockResolvedValue({ status: 200 });
    page(requestDeletePicture);

    await expect(deleteGroupPictureInPage(GROUP)).resolves.toBe(200);
    expect(requestDeletePicture).toHaveBeenCalledWith({ _serialized: GROUP });
  });

  it.each([401, 429, 500])('answers the status WhatsApp refused with (%i)', async status => {
    page(jest.fn().mockRejectedValue(refusal(status)));

    await expect(deleteGroupPictureInPage(GROUP)).resolves.toBe(status);
  });

  it('rethrows what is not a status from WhatsApp', async () => {
    page(jest.fn().mockRejectedValue(new Error('page closed')));
    await expect(deleteGroupPictureInPage(GROUP)).rejects.toThrow('page closed');

    page(jest.fn().mockRejectedValue(refusal('not a number')));
    await expect(deleteGroupPictureInPage(GROUP)).rejects.toThrow('status not a number');
  });

  // A build that lacks the job or the id factory: Meta's `require` throws for a module it does not define, and answers
  // `undefined` from a page.evaluate with no guard active. Nothing is sent either way.
  describe.each([
    ['the module is not defined (require throws)', (name: string) => ({ throws: name })],
    ['the module answers undefined', (name: string) => ({ answers: name })],
  ])('when %s', (_how, lacking) => {
    const lackingPage = (name: string, requestDeletePicture: jest.Mock) => {
      const { throws, answers } = lacking(name) as { throws?: string; answers?: string };
      const modules: Record<string, unknown> = {
        WAWebWidFactory: { createWid: (id: string) => ({ _serialized: id }) },
        WAWebContactProfilePicThumbBridge: { requestDeletePicture },
      };
      g.window = {
        require: (module: string) => {
          if (module === throws) throw new Error(`Requiring unknown module "${module}"`);
          return module === answers ? undefined : modules[module];
        },
      };
    };

    it.each(['WAWebContactProfilePicThumbBridge', 'WAWebWidFactory'])(
      'answers missing without sending when %s is gone',
      async name => {
        const requestDeletePicture = jest.fn();
        lackingPage(name, requestDeletePicture);

        await expect(deleteGroupPictureInPage(GROUP)).resolves.toBe('missing');
        expect(requestDeletePicture).not.toHaveBeenCalled();
      },
    );
  });

  it('answers missing when the modules lack the members the request needs', async () => {
    g.window = {
      require: (name: string) =>
        ({ WAWebWidFactory: { createWid: () => ({}) }, WAWebContactProfilePicThumbBridge: {} })[name as never],
    };
    await expect(deleteGroupPictureInPage(GROUP)).resolves.toBe('missing');

    g.window = {
      require: (name: string) =>
        ({ WAWebWidFactory: {}, WAWebContactProfilePicThumbBridge: { requestDeletePicture: jest.fn() } })[
          name as never
        ],
    };
    await expect(deleteGroupPictureInPage(GROUP)).resolves.toBe('missing');
  });

  // A document that has not defined `require` yet is a page that is reloading, not a build without the job.
  it('lets the failure of a document without require through', async () => {
    g.window = {};

    await expect(deleteGroupPictureInPage(GROUP)).rejects.toThrow('w.require is not a function');
  });

  describe('through the adapter', () => {
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

    it('answers 501 on a build with no job to delete with, before anything is asked of WhatsApp', async () => {
      g.window = {
        require: (name: string) => {
          if (name !== 'WAWebWidFactory') throw new Error(`Requiring unknown module "${name}"`);
          return { createWid: (id: string) => ({ _serialized: id }) };
        },
      };

      const attempt = adapterOnThatPage().deleteGroupPicture(GROUP);

      await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
      await expect(attempt).rejects.toThrow(/deleteGroupPicture\(no picture delete job on this build\)/);
    });

    it('answers 501 when the module answers undefined, as it does from a page.evaluate with no guard active', async () => {
      g.window = { require: () => undefined };

      await expect(adapterOnThatPage().deleteGroupPicture(GROUP)).rejects.toBeInstanceOf(EngineNotSupportedError);
    });

    it('answers the retryable 409 for a document that has no require yet', async () => {
      g.window = {};

      await expect(adapterOnThatPage().deleteGroupPicture(GROUP)).rejects.toBeInstanceOf(EngineNotReadyError);
    });

    it('still removes the picture where the job exists', async () => {
      page(jest.fn().mockResolvedValue({ status: 200 }));

      await expect(adapterOnThatPage().deleteGroupPicture(GROUP)).resolves.toBeUndefined();
    });
  });
});
