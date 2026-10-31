import { runInNewContext } from 'node:vm';
import { Client } from 'whatsapp-web.js';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { WwebjsLabels } from './wwebjs-labels';
import { type WwebjsEngineHost } from './wwebjs-host';

const CHAT = '628123456789@c.us';
const OTHER_CHAT = '628987654321@c.us';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

type Action = { id: string; type: 'add' | 'remove' };
type Command = { chats: string[]; actions: Action[] };

/** Run the installed SDK's action generator with inert collections and explicit visibility. */
function harness(initial: string[] = [], failure?: Error) {
  const entered = deferred();
  const release = deferred();
  const committed = deferred();
  const commands: Command[] = [];
  const definitions = ['A', 'B', 'C'].map(id => ({ id, name: id, hexColor: '#000000' }));
  const state = { ready: true, client: undefined as unknown as Client };

  function makeClient() {
    const chats = [CHAT, OTHER_CHAT].map(id => ({
      id: { _serialized: id },
      labels: id === CHAT ? [...initial] : [],
    }));
    let targetEvaluations = 0;
    let heldFirstWrite = false;
    const window = {
      WWebJS: { getLabels: () => definitions },
      require(module: string) {
        if (module === 'WAWebConnModel') return { Conn: { platform: 'smba' } };
        if (module !== 'WAWebCollections') throw new Error(`Unexpected page module: ${module}`);
        return {
          Chat: { filter: (predicate: (chat: (typeof chats)[number]) => boolean) => chats.filter(predicate) },
          Label: {
            async addOrRemoveLabels(actions: Action[], selected: typeof chats) {
              commands.push({
                chats: selected.map(chat => chat.id._serialized),
                actions: actions.map(action => ({ id: action.id, type: action.type })),
              });
              const hold = !heldFirstWrite && selected.some(chat => chat.id._serialized === CHAT);
              if (hold) {
                heldFirstWrite = true;
                entered.resolve();
                await release.promise;
              }
              try {
                if (hold && failure) throw failure;
                for (const chat of selected) {
                  const ids = new Set(chat.labels);
                  for (const action of actions) {
                    if (action.type === 'add') ids.add(action.id);
                    else ids.delete(action.id);
                  }
                  chat.labels = [...ids];
                }
              } finally {
                if (hold) committed.resolve();
              }
            },
          },
        };
      },
    };
    const client = {
      getChatById(id: string) {
        const model = chats.find(chat => chat.id._serialized === id);
        return Promise.resolve(
          model
            ? {
                id: model.id,
                getLabels: () =>
                  Promise.resolve(model.labels.map(label => definitions.find(definition => definition.id === label)!)),
              }
            : undefined,
        );
      },
      getLabels: () => Promise.resolve(definitions),
      addOrRemoveLabels(ids: string[], chatIds: string[]) {
        return Client.prototype.addOrRemoveLabels.call(client as unknown as Client, ids, chatIds);
      },
      pupPage: {
        async evaluate(fn: (...args: unknown[]) => Promise<unknown>, ids: string[], chatIds: string[]) {
          if (chatIds.includes(CHAT) && ++targetEvaluations > 1) {
            await committed.promise;
          }
          const evaluate = runInNewContext(`(${fn.toString()})`, { window }) as typeof fn;
          return evaluate(ids, chatIds);
        },
      },
    };
    return {
      client: client as unknown as Client,
      labels: (id = CHAT) => [...chats.find(chat => chat.id._serialized === id)!.labels].sort(),
    };
  }

  const original = makeClient();
  state.client = original.client;
  const host = {
    ensureReady() {
      if (!state.ready) throw new EngineNotReadyError();
    },
    getClient() {
      host.ensureReady();
      return state.client;
    },
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    logger: { debug: jest.fn() },
    config: { sessionId: 'label-session' },
  } as unknown as WwebjsEngineHost;

  return { labels: new WwebjsLabels(host), state, original, commands, entered, release };
}

describe('chat label membership updates', () => {
  it('keeps both additions when the first write becomes visible before the second SDK evaluation', async () => {
    const fixture = harness();
    const first = fixture.labels.addLabelToChat(CHAT, 'A');
    await fixture.entered.promise;
    const second = fixture.labels.addLabelToChat(CHAT, 'B');
    await nextTurn();
    fixture.release.resolve();
    await Promise.all([first, second]);

    expect(fixture.commands[1].actions).not.toContainEqual({ id: 'A', type: 'remove' });
    expect(fixture.original.labels()).toEqual(['A', 'B']);
  });

  it('does not restore a removed label while adding a different label', async () => {
    const fixture = harness(['A']);
    const first = fixture.labels.removeLabelFromChat(CHAT, 'A');
    await fixture.entered.promise;
    const second = fixture.labels.addLabelToChat(CHAT, 'B');
    await nextTurn();
    fixture.release.resolve();
    await Promise.all([first, second]);

    expect(fixture.commands[1].actions).not.toContainEqual({ id: 'A', type: 'add' });
    expect(fixture.original.labels()).toEqual(['B']);
  });

  it('releases a failed write so the next update can complete', async () => {
    const failure = new Error('Dummy label write failed');
    const fixture = harness([], failure);
    const first = fixture.labels.addLabelToChat(CHAT, 'A').catch(error => error as unknown);
    await fixture.entered.promise;
    const second = fixture.labels.addLabelToChat(CHAT, 'B');
    await nextTurn();
    fixture.release.resolve();

    expect(await first).toBe(failure);
    await second;
    expect(fixture.original.labels()).toEqual(['B']);
  });

  it('lets a different chat update finish while the first chat is waiting', async () => {
    const fixture = harness();
    const first = fixture.labels.addLabelToChat(CHAT, 'A');
    await fixture.entered.promise;
    let otherFinished = false;
    const other = fixture.labels.addLabelToChat(OTHER_CHAT, 'B').then(() => {
      otherFinished = true;
    });
    await nextTurn();
    const observedBeforeRelease = { finished: otherFinished, labels: fixture.original.labels(OTHER_CHAT) };
    fixture.release.resolve();
    await Promise.all([first, other]);

    expect(observedBeforeRelease).toEqual({ finished: true, labels: ['B'] });
  });

  it('rejects an update waiting behind a write when the session stops', async () => {
    const fixture = harness();
    const first = fixture.labels.addLabelToChat(CHAT, 'A').catch(error => error as unknown);
    await fixture.entered.promise;
    const second = fixture.labels.addLabelToChat(CHAT, 'B').catch(error => error as unknown);
    await nextTurn();
    fixture.state.ready = false;
    fixture.release.resolve();
    const results = await Promise.all([first, second]);

    expect(results[1]).toBeInstanceOf(EngineNotReadyError);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.original.labels()).toEqual(['A']);
  });
});
