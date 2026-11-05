import { runInNewContext } from 'node:vm';
import { Client } from 'whatsapp-web.js';
import { WwebjsLabels } from './wwebjs-labels';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * WhatsApp Web keys a migrated contact's chat by its lid and finds that same chat for the phone id. Two
 * single-label writes to that chat must not undo each other whichever id each caller names it by: the
 * page replaces the chat's whole label set from what it holds when it runs, so a write that read the
 * labels before the other one landed would remove the label that write just added, or restore one it removed.
 */
describe('label writes to one chat named by different ids', () => {
  const PHONE_CHAT = '628123456789@c.us';
  const LID_CHAT = '159442138038327@lid';
  const SERVER_DIALECT_CHAT = '628123456789@s.whatsapp.net';
  const UPPER_CASE_CHAT = '628123456789@C.US';
  const SPELLINGS_OF_THE_CHAT = [PHONE_CHAT, LID_CHAT, SERVER_DIALECT_CHAT, UPPER_CASE_CHAT];

  type Action = { id: string; type: 'add' | 'remove' };

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    return { promise, resolve };
  }

  const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

  function lidKeyedChat(initial: string[] = []) {
    const definitions = ['A', 'B'].map(id => ({ id, name: id, hexColor: '#000000' }));
    const chat = { id: { _serialized: LID_CHAT }, labels: [...initial] };
    const firstWriteEntered = deferred();
    const releaseFirstWrite = deferred();
    const firstWriteCommitted = deferred();
    const commands: Action[][] = [];
    let writes = 0;
    const window = {
      WWebJS: { getLabels: () => definitions },
      require(module: string) {
        if (module === 'WAWebConnModel') return { Conn: { platform: 'smba' } };
        return {
          Chat: { filter: (predicate: (candidate: typeof chat) => boolean) => [chat].filter(predicate) },
          Label: {
            async addOrRemoveLabels(actions: Action[], selected: (typeof chat)[]) {
              commands.push(actions.map(action => ({ id: action.id, type: action.type })));
              const first = ++writes === 1;
              if (first) {
                // The first write is on its way to WhatsApp while the second request reads the labels.
                firstWriteEntered.resolve();
                await releaseFirstWrite.promise;
              }
              for (const target of selected) {
                const ids = new Set(target.labels);
                for (const action of actions) {
                  if (action.type === 'add') ids.add(action.id);
                  else ids.delete(action.id);
                }
                target.labels = [...ids];
              }
              if (first) firstWriteCommitted.resolve();
            },
          },
        };
      },
    };
    let evaluations = 0;
    const client = {
      getChatById: (id: string) =>
        Promise.resolve(
          SPELLINGS_OF_THE_CHAT.includes(id)
            ? {
                id: chat.id,
                getLabels: () => Promise.resolve(definitions.filter(d => chat.labels.includes(d.id))),
              }
            : undefined,
        ),
      getLabels: () => Promise.resolve(definitions),
      addOrRemoveLabels: (ids: string[], chatIds: string[]) =>
        Client.prototype.addOrRemoveLabels.call(client as unknown as Client, ids, chatIds),
      pupPage: {
        async evaluate(fn: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]) {
          // The second write reaches the page once the first one has landed there.
          if (++evaluations > 1) await firstWriteCommitted.promise;
          return (runInNewContext(`(${fn.toString()})`, { window }) as typeof fn)(...args);
        },
      },
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger: { debug: jest.fn() },
      config: { sessionId: 'label-session' },
    } as unknown as WwebjsEngineHost;
    return { labels: new WwebjsLabels(host), chat, commands, firstWriteEntered, releaseFirstWrite };
  }

  it.each([
    ['the phone id and the lid', PHONE_CHAT, LID_CHAT],
    ['the lid and the phone id', LID_CHAT, PHONE_CHAT],
    ['the server dialect and the lid', SERVER_DIALECT_CHAT, LID_CHAT],
    ['an upper-case phone id and the lid', UPPER_CASE_CHAT, LID_CHAT],
    ['the same phone id twice', PHONE_CHAT, PHONE_CHAT],
  ])('keeps both labels when %s each add one at the same time', async (_names, firstChat, secondChat) => {
    const fixture = lidKeyedChat();
    const first = fixture.labels.addLabelToChat(firstChat, 'A');
    await fixture.firstWriteEntered.promise;
    const second = fixture.labels.addLabelToChat(secondChat, 'B');
    await nextTurn();
    fixture.releaseFirstWrite.resolve();
    await Promise.all([first, second]);

    expect(fixture.commands[1]).not.toContainEqual({ id: 'A', type: 'remove' });
    expect([...fixture.chat.labels].sort()).toEqual(['A', 'B']);
  });

  it('does not restore a removed label when the other id adds a different one', async () => {
    const fixture = lidKeyedChat(['A']);
    const first = fixture.labels.removeLabelFromChat(PHONE_CHAT, 'A');
    await fixture.firstWriteEntered.promise;
    const second = fixture.labels.addLabelToChat(LID_CHAT, 'B');
    await nextTurn();
    fixture.releaseFirstWrite.resolve();
    await Promise.all([first, second]);

    expect(fixture.commands[1]).not.toContainEqual({ id: 'A', type: 'add' });
    expect(fixture.chat.labels).toEqual(['B']);
  });
});
