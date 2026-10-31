import { type Client } from 'whatsapp-web.js';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { WwebjsGroups } from './wwebjs-groups';
import { type WwebjsEngineHost } from './wwebjs-host';
import { toMessageMedia } from './wwebjs-messaging';

jest.mock('./wwebjs-messaging', () => ({ toMessageMedia: jest.fn() }));
jest.mock('./wwebjs-chats', () => ({ listChats: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const GROUP = '120363123456@g.us';
const INPUT = { mimetype: 'image/png', data: 'QUJD' };
const PICTURE = { mimetype: 'image/png', data: 'QUJD', filename: 'dummy.png' };

function harness() {
  const media = deferred<unknown>();
  const mediaEntered = deferred<void>();
  const commands: unknown[] = [];
  const state = { ready: true };
  const client = {
    getChatById: () =>
      Promise.resolve({
        id: { _serialized: GROUP },
        isGroup: true,
        setPicture(picture: unknown) {
          commands.push(picture);
          return Promise.resolve(true);
        },
      }),
  } as unknown as Client;
  jest.mocked(toMessageMedia).mockImplementation(() => {
    mediaEntered.resolve();
    return media.promise as ReturnType<typeof toMessageMedia>;
  });
  const host = {
    ensureReady() {
      if (!state.ready) throw new EngineNotReadyError();
    },
    getClient() {
      host.ensureReady();
      return client;
    },
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    config: { sessionId: 'picture-session' },
    logger: { debug: jest.fn() },
  } as unknown as WwebjsEngineHost;
  return { groups: new WwebjsGroups(host), state, commands, media, mediaEntered };
}

describe('group picture write when the session stops during media preparation', () => {
  afterEach(() => jest.clearAllMocks());

  it('writes the picture when the session stays ready', async () => {
    const fixture = harness();
    const pending = fixture.groups.setGroupPicture(GROUP, INPUT);
    await fixture.mediaEntered.promise;
    fixture.media.resolve(PICTURE);
    await pending;

    expect(fixture.commands).toEqual([PICTURE]);
  });

  it('answers not-ready without writing when the session stopped meanwhile', async () => {
    const fixture = harness();
    const pending = fixture.groups.setGroupPicture(GROUP, INPUT).catch(error => error as unknown);
    await fixture.mediaEntered.promise;
    fixture.state.ready = false;
    fixture.media.resolve(PICTURE);
    const result = await pending;

    expect(result).toBeInstanceOf(EngineNotReadyError);
    expect(fixture.commands).toEqual([]);
  });

  it('keeps a media preparation error and writes nothing', async () => {
    const fixture = harness();
    const failure = new Error('Dummy media preparation failed');
    const pending = fixture.groups.setGroupPicture(GROUP, INPUT).catch(error => error as unknown);
    await fixture.mediaEntered.promise;
    fixture.media.reject(failure);

    expect(await pending).toBe(failure);
    expect(fixture.commands).toEqual([]);
  });
});
