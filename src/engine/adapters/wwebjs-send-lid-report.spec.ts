import { EventEmitter } from 'events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type LidMappingStore } from '../identity/lid-mapping-store.service';

/**
 * A send that resolves a phone id to a lid records the pair for every reader of the shared table (inbound lid
 * resolution, the chat fence). WhatsApp can hold the account under another digit string than the one typed (the
 * extra mobile digit of Brazilian, Mexican and Argentine numbers), so the phone recorded is the one WhatsApp Web holds
 * for the lid, and the typed digits only when it holds none.
 */
describe('the lid a whatsapp-web.js send learns', () => {
  const TYPED = '5511987654321@c.us';
  const HELD = '551187654321@c.us';
  const LID = '159442138038327@lid';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  function setup(held: { _serialized?: string; $1?: string } | null | Error) {
    const remember = jest.fn().mockResolvedValue(true);
    const getPhoneNumber = jest.fn(() => {
      if (held instanceof Error) throw held;
      return held;
    });
    const modules: Record<string, unknown> = {
      WAWebWidFactory: { createWid: (id: string) => ({ _serialized: id }) },
      WAWebApiContact: { getPhoneNumber },
    };
    g.window = { require: (name: string) => modules[name] };
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 's1',
      sessionDataPath: './data/sessions',
      puppeteer: {},
      lidMappingStore: { remember } as unknown as LidMappingStore,
    });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { client: unknown }).client = Object.assign(new EventEmitter(), {
      pupBrowser: new EventEmitter(),
      pupPage: Object.assign(new EventEmitter(), {
        // The in-page read runs against the stand-in window above.
        evaluate: jest.fn((fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise.resolve(fn(...args))),
      }),
      getNumberId: jest.fn().mockResolvedValue({ _serialized: LID }),
      sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: `true_${LID}_M1` }, timestamp: 1 }),
    });
    return { adapter, remember, getPhoneNumber };
  }

  const settle = () => new Promise(resolve => setImmediate(resolve));

  it.each([{ _serialized: HELD }, { $1: HELD }])(
    'records the phone WhatsApp Web holds for the lid (%o), not the digits typed',
    async held => {
      const { adapter, remember, getPhoneNumber } = setup(held);

      await adapter.sendTextMessage(TYPED, 'hi');
      await settle();

      expect(getPhoneNumber).toHaveBeenCalledWith({ _serialized: LID });
      expect(remember).toHaveBeenCalledWith('159442138038327', '551187654321', 's1');
    },
  );

  it.each([
    ['holds no phone for the lid', null],
    ['cannot be read', new Error('Evaluation failed: TypeError')],
  ])('records the typed digits when the page %s', async (_case, held) => {
    const { adapter, remember } = setup(held);

    await adapter.sendTextMessage(TYPED, 'hi');
    await settle();

    expect(remember).toHaveBeenCalledWith('159442138038327', '5511987654321', 's1');
  });
});
