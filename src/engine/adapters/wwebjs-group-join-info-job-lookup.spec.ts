import { EventEmitter } from 'events';
import * as wwebjs from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';

const { Client } = wwebjs as unknown as { Client: { prototype: object } };

/**
 * The preview of an invite runs `queryGroupInvite` of `WAWebGroupQueryJob`. A build whose job module lost that
 * function made the call a TypeError in the page, which the adapter read as a refused invite, so every valid code was the
 * 404 of an unknown invite. The job is looked up first now, and a build without it answers the 501 of a build with no
 * job before anything is asked of WhatsApp, as the revoke and the join do. A job that is there and refuses is still the
 * 404, and a rate limit still the retryable 503.
 */
describe('the invite preview on a build whose job module may lack the call', () => {
  const GID = '120363000000000001@g.us';
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  /** A page whose `require` answers the given modules: `undefined` for a module it holds as undefined, an error for the rest. */
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
    (adapter as unknown as { client: unknown }).client = Object.assign(
      Object.create(Client.prototype) as EventEmitter,
      {
        pupPage: {
          evaluate: (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => Promise.resolve().then(() => fn(...a)),
        },
      },
    );
    return adapter;
  };

  const MISSING = [
    ['the module has no queryGroupInvite', { WAWebGroupQueryJob: {} }],
    ['queryGroupInvite is not a function', { WAWebGroupQueryJob: { queryGroupInvite: 'gone' } }],
    ['the module answers undefined', { WAWebGroupQueryJob: undefined }],
    ['the module is not defined', {}],
  ] as Array<[string, Record<string, unknown>]>;

  it.each(MISSING)('answers 501 and not the unknown invite when %s', async (_case, modules) => {
    page(modules);

    const error = await adapterOnThatPage()
      .getGroupJoinInfo('CODE')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineNotSupportedError);
    expect(error).not.toBeInstanceOf(GroupNotFoundError);
    expect((error as Error).message).toContain('getGroupJoinInfo(no invite preview job on this build)');
  });

  it('asks nothing of WhatsApp when the job is gone', async () => {
    const queryGroupInvite = jest.fn();
    page({ WAWebGroupQueryJob: { other: queryGroupInvite } });

    await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(EngineNotSupportedError);

    expect(queryGroupInvite).not.toHaveBeenCalled();
  });

  it('still reads what the job resolves', async () => {
    const queryGroupInvite = jest.fn().mockResolvedValue({ id: { _serialized: GID }, subject: 'Team', size: 3 });
    page({ WAWebGroupQueryJob: { queryGroupInvite } });

    await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).resolves.toEqual({
      id: GID,
      name: 'Team',
      participantCount: 3,
    });
    expect(queryGroupInvite.mock.calls).toEqual([['CODE']]);
  });

  it('keeps the 404 of an invite the job refuses', async () => {
    page({
      WAWebGroupQueryJob: {
        queryGroupInvite: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('gone'), { name: 'ServerStatusCodeError', status: 404 })),
      },
    });

    await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('keeps the retryable 503 of a rate limit', async () => {
    page({
      WAWebGroupQueryJob: {
        queryGroupInvite: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ServerStatusCodeError', status: 429 })),
      },
    });

    await expect(adapterOnThatPage().getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(EngineTransportError);
  });
});
