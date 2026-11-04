import { EventEmitter } from 'events';
import { WAState } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { NAVIGATION_REINJECT_GRACE_MS, WwebjsLifecycle } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

/**
 * After WhatsApp Web reloads a ready page, whatsapp-web.js has to re-inject its helpers (`window.WWebJS`) into the
 * new document before any page call can work. Inside the reload grace every operation answers the retryable 409
 * that names the reload. Once the liveness probe has read the new page and found the helpers missing, an operation
 * is just as certain to die on the page, so it must get the same 409 rather than reach the page and fail there as an
 * unclassified engine error (a 500 that keeps a send's idempotency key taken and counts toward the send breaker).
 */
describe('operations on a reloaded page the probe found without its helpers', () => {
  const GROUP = '120363000000000000@g.us';

  /** What Node receives from a page call on a document without `window.WWebJS` (puppeteer 25, headless Chromium). */
  const helpersMissingError = (): Error => {
    const error = new Error("Cannot read properties of undefined (reading 'getChat')");
    error.name = 'TypeError';
    return error;
  };

  const wire = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'sess-reload-ops', sessionDataPath: './data/sessions' });
    const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn().mockResolvedValue(false) });
    const client = Object.assign(new EventEmitter(), {
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      sendMessage: jest.fn().mockRejectedValue(helpersMissingError()),
      pupBrowser: new EventEmitter(),
      pupPage,
    });
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    lifecycle.setupEventHandlers();
    lifecycle.attachPuppeteerLifecycleListeners();
    return { adapter, client };
  };
  const reload = (client: EventEmitter & { pupPage: EventEmitter }): void => {
    client.pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refuses a send inside the reload grace without reaching the page', async () => {
    const { adapter, client } = wire();
    reload(client);
    jest.setSystemTime(Date.now() + 5_000);

    await expect(adapter.sendTextMessage(GROUP, 'hello')).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a send after the grace once the probe found the helpers missing, without reaching the page', async () => {
    const { adapter, client } = wire();
    reload(client);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS + 5_000);
    // The watchdog's probe: CONNECTED, but the new document has no helpers. Still healing, so alive.
    await expect(adapter.probeLiveness()).resolves.toBe(true);

    const outcome = await adapter.sendTextMessage(GROUP, 'hello').catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(EngineNotReadyError);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a page read after the grace once the probe found the helpers missing', async () => {
    const { adapter, client } = wire();
    reload(client);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS + 5_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    client.pupPage.evaluate.mockClear();
    client.pupPage.evaluate.mockRejectedValue(helpersMissingError());

    const outcome = await adapter.getChats().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(EngineNotReadyError);
    expect(client.pupPage.evaluate).not.toHaveBeenCalled();
  });

  it('sends normally once the reloaded page is found re-injected', async () => {
    const { adapter, client } = wire();
    reload(client);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS + 5_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    client.pupPage.evaluate.mockResolvedValue(true);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    client.sendMessage.mockResolvedValue({ id: { _serialized: 'true_x@g.us_ABC' }, timestamp: 1 });

    await expect(adapter.sendTextMessage(GROUP, 'hello')).resolves.toEqual({ id: 'true_x@g.us_ABC', timestamp: 1 });
  });

  // The 'ready' that ends a re-inject asks the page for the helpers; when that one read fails nothing has said the
  // helpers are missing, so the page is not refused on suspicion alone.
  it('sends normally after a re-inject whose ready-time helpers read failed, when no probe found them missing', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockRejectedValueOnce(new Error('Runtime.callFunctionOn timed out.'));
    reload(client);
    jest.setSystemTime(Date.now() + 8_000);
    client.emit('ready');
    await jest.advanceTimersByTimeAsync(0);
    client.sendMessage.mockResolvedValue({ id: { _serialized: 'true_x@g.us_GHI' }, timestamp: 3 });

    await expect(adapter.sendTextMessage(GROUP, 'hello')).resolves.toEqual({ id: 'true_x@g.us_GHI', timestamp: 3 });
  });

  it('sends normally after a reload whose ready found the helpers, with no probe in between', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockResolvedValue(true);
    reload(client);
    jest.setSystemTime(Date.now() + 8_000);
    client.emit('ready');
    await jest.advanceTimersByTimeAsync(0);
    client.sendMessage.mockResolvedValue({ id: { _serialized: 'true_x@g.us_DEF' }, timestamp: 2 });

    await expect(adapter.sendTextMessage(GROUP, 'hello')).resolves.toEqual({ id: 'true_x@g.us_DEF', timestamp: 2 });
  });

  // A protocol timeout on a busy page is no answer about the helpers: refusing on it would turn a healthy page away
  // until the next probe, a minute later.
  it('sends normally after the grace when the probe could not read the helpers, on a page that has them', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate
      .mockRejectedValueOnce(new Error('Runtime.callFunctionOn timed out.'))
      .mockResolvedValue(true);
    reload(client);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS + 5_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    client.sendMessage.mockResolvedValue({ id: { _serialized: 'true_x@g.us_JKL' }, timestamp: 4 });

    await expect(adapter.sendTextMessage(GROUP, 'hello')).resolves.toEqual({ id: 'true_x@g.us_JKL', timestamp: 4 });
  });

  it('sends normally once the re-inject re-emits ready and the page answers with its helpers', async () => {
    const { adapter, client } = wire();
    reload(client);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS + 5_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    client.pupPage.evaluate.mockResolvedValue(true);
    client.emit('ready');
    await jest.advanceTimersByTimeAsync(0);
    client.sendMessage.mockResolvedValue({ id: { _serialized: 'true_x@g.us_MNO' }, timestamp: 5 });

    await expect(adapter.sendTextMessage(GROUP, 'hello')).resolves.toEqual({ id: 'true_x@g.us_MNO', timestamp: 5 });
  });

  // The answer was about the document the next reload replaced; the new one has not been read yet.
  it('sends normally past the grace of a later reload, with no probe since it', async () => {
    const { adapter, client } = wire();
    reload(client);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS + 5_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    reload(client);
    jest.setSystemTime(Date.now() + 5_000);
    await expect(adapter.sendTextMessage(GROUP, 'hello')).rejects.toBeInstanceOf(EngineNotReadyError);
    jest.setSystemTime(Date.now() + NAVIGATION_REINJECT_GRACE_MS);
    client.sendMessage.mockResolvedValue({ id: { _serialized: 'true_x@g.us_PQR' }, timestamp: 6 });

    await expect(adapter.sendTextMessage(GROUP, 'hello')).resolves.toEqual({ id: 'true_x@g.us_PQR', timestamp: 6 });
  });
});
