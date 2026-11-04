import type { Client } from 'whatsapp-web.js';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { WwebjsMessaging } from './wwebjs-messaging';
import type { WwebjsEngineHost } from './wwebjs-host';

const CHAT = '628111@c.us';
const MESSAGE = 'true_628111@c.us_dummy';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

type Operation = 'react' | 'delete' | 'edit' | 'vote' | 'pin' | 'star' | 'unstar' | 'unpin';
type Stage = 'chat' | 'messages';
const operations: Operation[] = ['react', 'delete', 'edit', 'vote', 'pin', 'star', 'unstar', 'unpin'];
const stages: Stage[] = ['chat', 'messages'];

const invoke = (messaging: WwebjsMessaging, operation: Operation): Promise<unknown> => {
  switch (operation) {
    case 'react':
      return messaging.reactToMessage(CHAT, MESSAGE, 'x');
    case 'delete':
      return messaging.deleteMessage(CHAT, MESSAGE, true);
    case 'edit':
      return messaging.editMessage(CHAT, MESSAGE, 'edited body');
    case 'vote':
      return messaging.votePoll(CHAT, MESSAGE, ['a']);
    case 'pin':
      return messaging.pinMessage(CHAT, MESSAGE, 86400);
    case 'star':
      return messaging.starMessage(CHAT, MESSAGE, true);
    case 'unstar':
      return messaging.starMessage(CHAT, MESSAGE, false);
    case 'unpin':
      return messaging.unpinMessage(CHAT, MESSAGE);
  }
};

/** A READY client whose chat lookup or message fetch is held at `stage` until the test releases it. */
function fixture(operation: Operation, stage?: Stage) {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const result = { id: { _serialized: MESSAGE, id: 'dummy' }, timestamp: 1 };
  const mutation = jest
    .fn()
    .mockResolvedValue(operation === 'edit' ? result : operation === 'pin' || operation === 'unpin' ? true : undefined);
  const message = {
    ...result,
    pollOptions: [{ name: 'a' }, { name: 'b' }],
    react: mutation,
    delete: mutation,
    edit: mutation,
    vote: mutation,
    pin: mutation,
    star: mutation,
    unstar: mutation,
    unpin: mutation,
  };
  const wait = async <T>(name: Stage, value: T): Promise<T> => {
    if (stage === name) {
      entered.resolve();
      await gate.promise;
    }
    return value;
  };
  const chat = { fetchMessages: jest.fn(() => wait('messages', [message])) };
  const client = { getChatById: jest.fn(() => wait('chat', chat)) };
  let ready = true;
  const host = {
    ensureReady() {
      if (!ready) throw new EngineNotReadyError();
    },
    getClient() {
      host.ensureReady();
      return client as unknown as Client;
    },
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    config: {},
  } as unknown as WwebjsEngineHost;
  return {
    messaging: new WwebjsMessaging(host),
    mutation,
    entered,
    gate,
    stopSession: () => {
      ready = false;
    },
  };
}

describe('message mutations when the session stops during their lookup', () => {
  it.each(operations)('runs %s on a session that stays ready', async operation => {
    const test = fixture(operation);
    await invoke(test.messaging, operation);
    expect(test.mutation).toHaveBeenCalledTimes(1);
  });

  const stopped = operations.flatMap(operation => stages.map(stage => ({ operation, stage })));
  it.each(stopped)(
    'refuses $operation after the session stopped during the $stage lookup',
    async ({ operation, stage }) => {
      const test = fixture(operation, stage);
      const done = invoke(test.messaging, operation).catch((error: unknown) => error);
      await test.entered.promise;
      test.stopSession();
      test.gate.resolve();
      expect(await done).toBeInstanceOf(EngineNotReadyError);
      expect(test.mutation).not.toHaveBeenCalled();
    },
  );

  it.each(stopped)('keeps the $stage lookup failure of $operation', async ({ operation, stage }) => {
    const test = fixture(operation, stage);
    const failure = new Error('dummy lookup unavailable');
    const done = invoke(test.messaging, operation).catch((error: unknown) => error);
    await test.entered.promise;
    test.gate.reject(failure);
    expect(await done).toBe(failure);
    expect(test.mutation).not.toHaveBeenCalled();
  });
});
