import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { revokeInviteInPage } from './wwebjs-groups';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

const { Client } = wwebjs as unknown as { Client: { prototype: object } };

/**
 * The revoke of a group's invite code resets it with a job of WhatsApp Web, addressed by an id that the page's wid factory
 * builds. Every lookup of that function tests the answer and guards the throw, and the answer of a page that has the job
 * but not the factory is `'missing'`, which the adapter turns into the 501 of a build that cannot make the request, with
 * nothing asked of WhatsApp. The factory used to be read after the job was found, with no test of the answer, so such a
 * page died on a TypeError reading `createWid` and the route answered a bare 500.
 *
 * From a page.evaluate Meta's `require` answers `undefined` for a module the page has not defined, and throws only inside
 * a guard or before the page's error setup has run; both are run.
 */
describe('revoking a group invite code on a page without the wid factory', () => {
  const GROUP = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  interface Page {
    /** Module names this build does not define. */
    without?: string[];
    unknownModule?: 'throws' | 'undefined';
    /** What the factory module holds, by default `createWid`. */
    factory?: unknown;
  }

  const installPage = (page: Page = {}) => {
    const resetGroupInviteCode = jest.fn().mockResolvedValue({ code: 'NEWCODE' });
    const modules: Record<string, unknown> = {
      WAWebGroupInviteJob: { resetGroupInviteCode },
      WAWebWidFactory: page.factory ?? { createWid: (id: string) => ({ _serialized: id }) },
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
    return resetGroupInviteCode;
  };

  const adapterOnThatPage = () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = Object.assign(Object.create(Client.prototype) as object, {
      getChatById: jest.fn().mockResolvedValue({ id: { _serialized: GROUP }, isGroup: true, participants: [] }),
      pupPage: {
        evaluate: (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => Promise.resolve().then(() => fn(...a)),
      },
    });
    return adapter;
  };

  it('resets the code, addressing the group by the id the factory builds, when the page has both', async () => {
    const reset = installPage();

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).resolves.toBe('NEWCODE');
    expect(reset.mock.calls).toEqual([[{ _serialized: GROUP }]]);
  });

  describe.each<[string, 'throws' | 'undefined']>([
    ['the module is not defined (require throws)', 'throws'],
    ['the module answers undefined', 'undefined'],
  ])('when %s', (_how, unknownModule) => {
    it('answers 501 without asking WhatsApp when the wid factory is gone', async () => {
      const reset = installPage({ without: ['WAWebWidFactory'], unknownModule });

      const attempt = adapterOnThatPage().revokeGroupInviteCode(GROUP);

      await expect(attempt).rejects.toBeInstanceOf(EngineNotSupportedError);
      await expect(attempt).rejects.toThrow(/revokeGroupInviteCode\(no reset job on this build\)/);
      expect(reset).not.toHaveBeenCalled();
    });

    it('answers missing from the page function itself', async () => {
      installPage({ without: ['WAWebWidFactory'], unknownModule });

      await expect(revokeInviteInPage(GROUP)).resolves.toBe('missing');
    });
  });

  it('answers 501 when the factory module has no createWid', async () => {
    const reset = installPage({ factory: {} });

    await expect(adapterOnThatPage().revokeGroupInviteCode(GROUP)).rejects.toBeInstanceOf(EngineNotSupportedError);
    expect(reset).not.toHaveBeenCalled();
  });

  // A document that has not defined `require` yet is a page that is reloading, not a build without the factory.
  it('lets the failure of a document without require through', async () => {
    g.window = {};

    await expect(revokeInviteInPage(GROUP)).rejects.toThrow('w.require is not a function');
  });
});
