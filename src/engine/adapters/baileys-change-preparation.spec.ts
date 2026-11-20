import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { createLogger } from '../../common/services/logger.service';

/**
 * A reaction, an edit, a delete and a vote are each prepared through a slot in the queue of the message they change
 * and a wait of the caller. Nothing of a change may stay attached to anything that outlives it while the account stays
 * linked. Racing those waits against a promise shared by every change would keep a reaction per race until the store
 * is wiped.
 *
 * The measure is the most reactions any one promise gathers (Promise.race chains onto each of its inputs), so a
 * promise shared by the changes shows as one reaction per change. It counts calls, not bytes or time, so it does not
 * depend on how fast or how loaded the machine is.
 */

const CHAT = '628111@s.whatsapp.net';
/** Changes per case. A promise shared by the changes would gather at least one reaction per change. */
const CHANGES = 2_000;
/** Far above what one change chains onto a promise of its own, far below one per change. */
const MOST_REACTIONS = 50;
/** What the adapter prepares at once; later arrivals wait for room. */
const PREPARING_LIMIT = 64;
const WAIT_MS = 60_000;

async function until(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

type Internals = {
  preparationRetirements: Set<() => void>;
  prepareMessageChange(
    messageId: string | null | undefined,
    opts: { generation: number },
    work: (releasePreparation: () => void) => Promise<void>,
  ): Promise<void>;
  changesPreparing: number;
  messageChanges: { size: number };
};

const internals = (events: BaileysEvents): Internals => events as unknown as Internals;

const prepare = (
  events: BaileysEvents,
  messageId: string | null,
  work: (releasePreparation: () => void) => Promise<void>,
): Promise<void> =>
  internals(events).prepareMessageChange(messageId, { generation: events.getStoredWriteGeneration() }, work);

/** Nothing of the machinery is in flight: no slot taken, no message queue holding a chain. */
const quiet = (events: BaileysEvents): boolean =>
  internals(events).changesPreparing === 0 && internals(events).messageChanges.size === 0;

/** Counts the reactions chained onto each promise until stopped. */
function watchReactions(): { busiest: () => number; stop: () => void } {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its receiver below
  const then = Promise.prototype.then;
  const counts = new WeakMap<object, number>();
  let busiest = 0;
  Promise.prototype.then = function (this: Promise<unknown>, ...args: Parameters<typeof then>) {
    const count = (counts.get(this) ?? 0) + 1;
    counts.set(this, count);
    busiest = Math.max(busiest, count);
    return then.apply(this, args);
  } as typeof then;
  return {
    busiest: () => busiest,
    stop: () => {
      Promise.prototype.then = then;
    },
  };
}

/** Runs `body` and gives the most reactions any one promise gathered meanwhile. */
async function reactionsOf(body: () => Promise<void>): Promise<number> {
  const watch = watchReactions();
  try {
    await body();
  } finally {
    watch.stop();
  }
  return watch.busiest();
}

const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType: (content: Record<string, unknown> | undefined) =>
    Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
  BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v },
  proto: {
    Message: {
      ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } },
      SecretEncryptedMessage: { SecretEncType: { MESSAGE_EDIT: 2 } },
    },
  },
  downloadMediaMessage: jest.fn(),
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const original = {
  key: { id: 'ORIG', remoteJid: CHAT, fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: { conversation: 'old text' },
} as unknown as WAMessage;

function build() {
  const seen = { reaction: 0, edit: 0, revoke: 0, reads: 0 };
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('ChangePreparationSpec'),
    loadLib: () => Promise.resolve(lib),
    getLoadedLib: () => lib,
    getFetchDispatcher: () => undefined,
    toNeutralJid: (jid: string) => jid,
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    inboundLimiter: new ConcurrencyLimiter(4),
    recordKeyLidMappings: () => undefined,
    recordMessage: () => undefined,
    recordMessageEdit: () => undefined,
    consumeOwnSend: () => false,
    getAdmitInbound: () => undefined,
    getStoredMessage: (id: string) => {
      seen.reads++;
      return Promise.resolve(id === 'ORIG' ? structuredClone(original) : null);
    },
    putStoredMessage: () => undefined,
    updateStoredMessage: () => Promise.resolve(),
    removeStoredMessage: () => undefined,
    getOnMessage: () => undefined,
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => () => {
      seen.revoke++;
    },
    getOnMessageEdited: () => () => {
      seen.edit++;
    },
    getOnMessageReaction: () => () => {
      seen.reaction++;
    },
    getOnMessageAck: () => undefined,
    getOnMessageReceipt: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnEventResponse: () => undefined,
    getOnPollVote: () => undefined,
    findContact: () => null,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
  } as unknown as BaileysEventsHost;
  return { events: new BaileysEvents(host), limiter: host.inboundLimiter, seen };
}

const target = { id: 'ORIG', remoteJid: CHAT, fromMe: false };

const change = (kind: string, i: number): WAMessage => {
  const content: Record<string, Record<string, unknown>> = {
    reaction: { reactionMessage: { key: target, text: 'x' } },
    edit: {
      protocolMessage: {
        type: 14,
        key: target,
        editedMessage: { conversation: `edit ${i}` },
        timestampMs: 1_700_000_100_000 + i,
      },
    },
    revoke: { protocolMessage: { type: 0, key: target } },
    // A vote and an encrypted edit for a message that is not stored: read, found unreadable, dropped.
    vote: {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: 'POLL', remoteJid: CHAT, fromMe: false },
        vote: { encPayload: Buffer.alloc(32), encIv: Buffer.alloc(12) },
      },
    },
    encrypted: {
      secretEncryptedMessage: {
        targetMessageKey: { id: 'ABSENT', remoteJid: CHAT, fromMe: false },
        encPayload: Buffer.alloc(32),
        encIv: Buffer.alloc(12),
        secretEncType: 2,
      },
    },
  };
  return {
    key: { id: `${kind.toUpperCase()}${i}`, remoteJid: CHAT, fromMe: false },
    messageTimestamp: 1_700_000_100 + i,
    message: content[kind],
  };
};

describe('BaileysEvents change preparation', () => {
  it('sees a promise that is raced against one that never settles (positive control)', async () => {
    const forever = new Promise<void>(() => undefined);
    const busiest = await reactionsOf(async () => {
      for (let i = 0; i < CHANGES; i++) await Promise.race([Promise.resolve(), forever]);
    });
    expect(busiest).toBeGreaterThanOrEqual(CHANGES);
  });

  it.each(['reaction', 'edit', 'revoke', 'vote', 'encrypted'])(
    'chains nothing onto a shared promise per %s',
    async kind => {
      const { events, limiter, seen } = build();
      const busiest = await reactionsOf(async () => {
        // Under the 64 preparations that run at once, so only the queue slot and the caller's wait are in play.
        const batch = 50;
        for (let i = 0; i < CHANGES; i += batch) {
          const messages = Array.from({ length: batch }, (_, k) => change(kind, i + k));
          events.handleMessagesUpsert({ type: 'notify', messages });
          await until(() => limiter.activeCount === 0 && limiter.queuedCount === 0, `the ${kind} batch`);
        }
        await until(() => quiet(events), 'the preparations to end');
      });

      // The changes did reach their handlers, not an early return.
      if (kind === 'reaction' || kind === 'edit') expect(seen[kind]).toBe(CHANGES);
      if (kind === 'revoke') expect(seen.revoke).toBeGreaterThan(0);
      if (kind === 'vote' || kind === 'encrypted') expect(seen.reads).toBeGreaterThanOrEqual(CHANGES);
      expect(busiest).toBeLessThan(MOST_REACTIONS);
    },
    WAIT_MS,
  );

  it(
    'chains nothing onto a shared promise per change that finished, parked or failed',
    async () => {
      const { events } = build();
      let failures = 0;
      const busiest = await reactionsOf(async () => {
        for (let i = 0; i < CHANGES; i++) {
          await prepare(events, `F${i}`, () => Promise.resolve());
          await prepare(events, `P${i}`, async release => {
            release();
            await prepare(events, `P${i}`, () => Promise.resolve());
          });
          await prepare(events, `X${i}`, () => Promise.reject(new Error('consumer failed'))).catch(() => failures++);
        }
        await until(() => quiet(events), 'the preparations to end');
      });

      expect(failures).toBe(CHANGES);
      expect(busiest).toBeLessThan(MOST_REACTIONS);
    },
    WAIT_MS,
  );

  it(
    'chains nothing onto a shared promise per arrival that waited for room',
    async () => {
      const { events } = build();
      const gates = Array.from({ length: PREPARING_LIMIT + 200 }, deferred);
      const busiest = await reactionsOf(async () => {
        const calls = gates.map((gate, i) => prepare(events, `W${i}`, () => gate.promise));
        await until(() => internals(events).changesPreparing === PREPARING_LIMIT, 'the queue to fill');
        // Every end wakes every arrival still waiting, and only one of them finds the room.
        for (let i = 0; i < gates.length; i++) {
          gates[i].resolve();
          await calls[i];
        }
        await until(() => quiet(events), 'the preparations to end');
      });

      expect(busiest).toBeLessThan(MOST_REACTIONS);
    },
    WAIT_MS,
  );

  it('forgets a preparation once it has ended, however it ended', async () => {
    const { events } = build();
    const remembered = (): number => internals(events).preparationRetirements.size;

    await prepare(events, 'A', () => Promise.resolve());
    expect(remembered()).toBe(0);

    await prepare(events, 'B', async release => {
      release();
      await prepare(events, 'B', () => Promise.resolve());
    });
    expect(remembered()).toBe(0);

    await expect(prepare(events, 'C', () => Promise.reject(new Error('consumer failed')))).rejects.toThrow(
      'consumer failed',
    );
    expect(remembered()).toBe(0);

    const gate = deferred();
    const stuck = prepare(events, 'D', () => gate.promise);
    expect(remembered()).toBe(1);
    events.fenceStoredWrites();
    await stuck;
    expect(remembered()).toBe(0);
    gate.resolve();
  });

  it(
    'ends every preparation of a retired store at once, however it waits',
    async () => {
      const { events } = build();
      const started: number[] = [];
      const parked = 4;
      const waiting = 16;
      const gates = Array.from({ length: PREPARING_LIMIT + waiting + parked }, deferred);
      let ended = 0;
      const calls = gates.map((gate, i) =>
        prepare(events, `R${i}`, async release => {
          started.push(i);
          // Some give up their slot, as a parked change does, and still wait for their own work. Others take it.
          if (i < parked) release();
          await gate.promise;
        }).then(() => ended++),
      );
      await until(() => started.length === PREPARING_LIMIT + parked, 'the slots to be taken');
      const startedBefore = started.length;

      events.fenceStoredWrites();
      await until(() => ended === gates.length, 'every preparation to end');
      await until(() => quiet(events), 'the slots to be given back');

      // The arrivals still waiting for room are not let in: their store was gone before they got a slot.
      expect(started).toHaveLength(startedBefore);
      gates.forEach(gate => gate.resolve());
      await Promise.all(calls);

      // The next store is not held back by the old one.
      let ran = false;
      await prepare(events, 'R0', () => {
        ran = true;
        return Promise.resolve();
      });
      expect(ran).toBe(true);
    },
    WAIT_MS,
  );
});
