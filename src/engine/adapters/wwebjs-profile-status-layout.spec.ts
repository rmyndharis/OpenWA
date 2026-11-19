import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

/**
 * `Client.setStatus` of whatsapp-web.js sets the About text through `setMyStatus` of WhatsApp Web's
 * `WAWebContactStatusBridge`. The build the gateway selects today exports only `queryStatusAll` and `sendReadStatus`
 * from that module: the About text became a text status that expires, set through modules the library does not call,
 * so the call was a TypeError in the page and the route answered a bare 500. The adapter asks the page whether the
 * export is there first, and a build without it answers 501 instead of guessing at the text-status modules, whose
 * semantics (an expiry, a gate by account) are not those of the plain About text.
 *
 * The module exports are those of build 2.3000.1054966512-alpha, read off its scripts, and the earlier layout adds the
 * `setMyStatus` the library was written for. Meta's `require` throws for a module a build does not define.
 */
describe('setting the About text on each WhatsApp Web layout', () => {
  const g = globalThis as unknown as { window?: unknown };
  const { Client } = wwebjs as unknown as {
    Client: { prototype: { setStatus(this: unknown, status: string): Promise<void> } };
  };

  afterEach(() => {
    delete g.window;
  });

  const pageWith = (modules: Record<string, unknown>) => {
    g.window = {
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Requiring unknown module "${name}"`);
        return modules[name];
      },
    };
  };

  /** WAWebContactStatusBridge on the pinned build. */
  const pinnedBridge = () => ({ queryStatusAll: jest.fn(), sendReadStatus: jest.fn() });

  /** The library's own `setStatus` runs against the fake page, so a call that reaches the page is the library's. */
  const adapterOnThatPage = () => {
    const evaluate = jest.fn((fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      Promise.resolve().then(() => fn(...args)),
    );
    const client: Record<string, unknown> = {
      info: { wid: { _serialized: '628000000001@c.us', user: '628000000001' } },
      pupPage: { evaluate },
    };
    client.setStatus = (status: string) => Client.prototype.setStatus.call(client, status);
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return { adapter, evaluate };
  };

  it('sets the text through setMyStatus on a build that still exports it', async () => {
    const setMyStatus = jest.fn().mockResolvedValue(undefined);
    pageWith({ WAWebContactStatusBridge: { ...pinnedBridge(), setMyStatus } });

    await expect(adapterOnThatPage().adapter.setProfileStatus('Busy')).resolves.toBeUndefined();
    expect(setMyStatus).toHaveBeenCalledWith('Busy');
  });

  it.each([
    ['the module has no setMyStatus, as on the pinned build', { WAWebContactStatusBridge: pinnedBridge() }],
    ['the module is not defined', {}],
  ])('answers 501 and writes nothing when %s', async (_case, modules) => {
    pageWith(modules);
    const { adapter, evaluate } = adapterOnThatPage();

    const attempt = adapter.setProfileStatus('Busy');
    await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
    await expect(attempt).rejects.toThrow(/setProfileStatus\(no status setter on this build\)/);
    // One page call: the check for the setter. The library's setStatus was never run.
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure of setMyStatus as it was', async () => {
    const failure = new Error('Evaluation failed: not allowed');
    pageWith({ WAWebContactStatusBridge: { ...pinnedBridge(), setMyStatus: jest.fn().mockRejectedValue(failure) } });

    await expect(adapterOnThatPage().adapter.setProfileStatus('Busy')).rejects.toBe(failure);
  });

  // A document that has not defined `require` yet is a page that is reloading: the retryable 409, which it must not
  // trade for a 501 that says this build cannot set the text.
  it('lets a document without require through as the reload it is, not as a build without the setter', async () => {
    g.window = {};

    await expect(adapterOnThatPage().adapter.setProfileStatus('Busy')).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
