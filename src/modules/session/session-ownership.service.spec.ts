import { hostname } from 'node:os';
import { DataSource, Repository } from 'typeorm';
import { SessionOwnershipService } from './session-ownership.service';
import { Session } from './entities/session.entity';
import { SessionStatus } from './entities/session.entity';

/**
 * Run against a real in-memory database rather than a mocked repository, because the part that has
 * to be right is the SQL: the claim is a conditional UPDATE, and whether two processes can both
 * win a race depends on the WHERE clause actually filtering. A mock would agree with whatever the
 * query builder was asked to do and prove nothing about the outcome.
 */
describe('SessionOwnershipService', () => {
  let dataSource: DataSource;
  let sessions: Repository<Session>;

  const nodeConfig = (nodeId: string, leaseTtlMs = 60_000) =>
    ({
      get: (key: string) => ({ 'session.nodeId': nodeId, 'session.leaseTtlMs': leaseTtlMs })[key],
    }) as never;

  const service = (nodeId: string, leaseTtlMs?: number): SessionOwnershipService =>
    new SessionOwnershipService(sessions, nodeConfig(nodeId, leaseTtlMs));

  const seed = async (overrides: Partial<Session> = {}): Promise<Session> =>
    sessions.save(
      sessions.create({
        name: `s-${Math.floor(performance.now() * 1000)}-${overrides.nodeId ?? 'free'}`,
        status: SessionStatus.READY,
        config: {},
        ...overrides,
      }),
    );

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    });
    await dataSource.initialize();
    sessions = dataSource.getRepository(Session);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  afterEach(async () => {
    await sessions.clear();
  });

  describe('claiming', () => {
    it('claims a session nobody holds, recording this node and a future expiry', async () => {
      const session = await seed();

      await expect(service('node-a').claim(session.id)).resolves.toBe(true);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBe('node-a');
      expect(stored.claimedAt).toBeInstanceOf(Date);
      expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    // The whole point: the second process must lose, and must lose in the database rather than by
    // having read a stale row a moment earlier.
    it('refuses a session another node holds on a live lease', async () => {
      const session = await seed();
      await service('node-a').claim(session.id);

      await expect(service('node-b').claim(session.id)).resolves.toBe(false);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });

    it('lets a node re-claim what it already holds, so a restart is not blocked by itself', async () => {
      const session = await seed();
      const node = service('node-a');
      await node.claim(session.id);

      await expect(node.claim(session.id)).resolves.toBe(true);
    });

    // A delete fences its removal on the time the row was claimed that it read, so a claim of this node written after it
    // read the row must not move that time. Claims of one session that overlap each take this path.
    it('keeps the time this node took a row it already holds when it claims the row again', async () => {
      const claimedAt = new Date(Date.now() - 120_000);
      const session = await seed({ nodeId: 'node-a', claimedAt, leaseExpiresAt: new Date(Date.now() + 30_000) });

      // A claim with no memory of the row takes the write path, as one that began while another was writing does.
      await expect(service('node-a').claim(session.id)).resolves.toBe(true);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.claimedAt).toEqual(claimedAt);
      expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    });

    it.each([
      ['nobody holds it', {}],
      [
        'a node whose lease lapsed holds it',
        { nodeId: 'node-b', claimedAt: new Date(Date.now() - 120_000), leaseExpiresAt: new Date(Date.now() - 60_000) },
      ],
    ])('records when this node took a row that %s', async (_label, row) => {
      const session = await seed(row);
      const before = Date.now();

      await expect(service('node-a').claim(session.id)).resolves.toBe(true);

      expect((await sessions.findOneByOrFail({ id: session.id })).claimedAt!.getTime()).toBeGreaterThanOrEqual(before);
    });

    // A process that dies without releasing must not strand its sessions forever.
    it('takes over once the holder’s lease has lapsed', async () => {
      const session = await seed({
        nodeId: 'node-a',
        claimedAt: new Date(Date.now() - 120_000),
        leaseExpiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service('node-b').claim(session.id)).resolves.toBe(true);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-b');
    });

    it('only one of two nodes racing for the same free session wins', async () => {
      const session = await seed();

      const results = await Promise.all([service('node-a').claim(session.id), service('node-b').claim(session.id)]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  // Two claims of one session overlap on a node when two requests for it arrive within a few milliseconds. The renewal
  // the later one issues can run before the earlier claim's write, and its answer is then handled after that claim
  // settled: it describes the row as it was, not as the earlier claim left it.
  describe('two claims of one session that overlap on a node', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** Answer the first renewal after the test lets it, as the miss it would be had it run before the other claim. */
    const missedRenewal = (): { answer: () => void } => {
      let answer!: () => void;
      const reply = new Promise<{ affected: number; raw: never[]; generatedMaps: never[] }>(resolve => {
        answer = () => resolve({ affected: 0, raw: [], generatedMaps: [] });
      });
      jest.spyOn(sessions, 'update').mockImplementationOnce(() => reply);
      return { answer };
    };

    it('keeps the claim the earlier one settled when the renewal of the later one missed', async () => {
      const session = await seed();
      const node = service('node-a');
      const renewal = missedRenewal();
      let earlierOwned: (() => boolean) | undefined;
      let laterOwned: (() => boolean) | undefined;

      const earlier = node.claim(session.id, owns => (earlierOwned = owns));
      const later = node.claim(session.id, owns => (laterOwned = owns));
      await expect(earlier).resolves.toBe(true);
      renewal.answer();
      await expect(later).resolves.toBe(true);

      expect(earlierOwned!()).toBe(true);
      expect(laterOwned!()).toBe(true);
      expect(node.ownedIds()).toEqual([session.id]);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });

    it('refuses both when a live peer holds the session', async () => {
      const session = await seed();
      await service('node-b').claim(session.id);
      const node = service('node-a');
      const renewal = missedRenewal();
      const owned = jest.fn();

      const earlier = node.claim(session.id, owned);
      const later = node.claim(session.id, owned);
      await expect(earlier).resolves.toBe(false);
      renewal.answer();
      await expect(later).resolves.toBe(false);

      expect(owned).not.toHaveBeenCalled();
      expect(node.ownedIds()).toEqual([]);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-b');
    });
  });

  // What a node whose lease lapsed left unfinished (its bulk batches) is failed once this process takes
  // the session over, by claiming it or by releasing that node's claim.
  describe('taking a session over from a lapsed node', () => {
    const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
    const lapsedBy = (nodeId: string): Partial<Session> => ({
      nodeId,
      claimedAt: new Date(Date.now() - 120_000),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const liveBy = (nodeId: string): Partial<Session> => ({
      nodeId,
      claimedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    // A released row is not taken over: the node that released it may still be finishing its own
    // batches, and failing them under it would leave two writers on one batch row.
    it('runs the adoption handler for a claim of a lapsed foreign lease only', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const node = service('node-b');
      node.onAdoption(handler);
      const own = await seed(lapsedBy('node-b'));
      const live = await seed(liveBy('node-c'));
      const released = await seed();
      const orphaned = await seed(lapsedBy('node-a'));

      await expect(node.claim(own.id)).resolves.toBe(true);
      await expect(node.claim(live.id)).resolves.toBe(false);
      await expect(node.claim(released.id)).resolves.toBe(true);
      await settle();
      expect(handler).not.toHaveBeenCalled();

      await expect(node.claim(orphaned.id)).resolves.toBe(true);
      await settle();
      expect(handler.mock.calls).toEqual([[orphaned.id]]);
    });

    // A stop of a session whose holder died clears that holder's claim, and a later start then finds a
    // released row; the release is where the takeover happens.
    it('runs the adoption handler when a release clears a lapsed foreign claim, and only then', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const node = service('node-b');
      node.onAdoption(handler);
      const own = await seed(liveBy('node-b'));
      const live = await seed(liveBy('node-c'));
      const orphaned = await seed(lapsedBy('node-a'));

      await node.release(own.id);
      await node.release(live.id);
      await settle();
      expect(handler).not.toHaveBeenCalled();
      expect((await sessions.findOneByOrFail({ id: own.id })).nodeId).toBeNull();
      expect((await sessions.findOneByOrFail({ id: live.id })).nodeId).toBe('node-c');

      await node.release(orphaned.id);
      await settle();
      expect(handler.mock.calls).toEqual([[orphaned.id]]);
      expect((await sessions.findOneByOrFail({ id: orphaned.id })).nodeId).toBeNull();
    });

    // Awaiting the handler inside claim() held a start between its claim and the moment it counted as
    // starting; a stop landing then released the claim and the engine launched on a row nobody held.
    it('returns from the claim without waiting for the adoption handler', async () => {
      const node = service('node-b');
      const handler = jest.fn(() => new Promise<void>(() => undefined));
      node.onAdoption(handler);
      const session = await seed(lapsedBy('node-a'));

      await expect(node.claim(session.id)).resolves.toBe(true);
      await settle();
      expect(handler).toHaveBeenCalledWith(session.id);
    });

    it('keeps the claim when the adoption handler fails', async () => {
      const node = service('node-b');
      node.onAdoption(() => Promise.reject(new Error('database unavailable')));
      const session = await seed(lapsedBy('node-a'));

      await expect(node.claim(session.id)).resolves.toBe(true);
      await settle();
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-b');
    });

    it('makes ownership visible before invoking a detached adoption handler', async () => {
      const node = service('node-b');
      const observed: boolean[] = [];
      node.onAdoption(id => {
        observed.push(node.owns(id));
        return Promise.resolve();
      });
      const session = await seed(lapsedBy('node-a'));
      expect(await node.claim(session.id)).toBe(true);
      await settle();
      expect(observed).toEqual([true]);
    });
  });

  describe('releasing', () => {
    it('frees the session so a peer can take it without waiting for the lease', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);

      await nodeA.release(session.id);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBeNull();
      expect(stored.leaseExpiresAt).toBeNull();
      await expect(service('node-b').claim(session.id)).resolves.toBe(true);
    });

    // Releasing must be scoped to what this node holds, or a shutting-down process would hand away
    // a peer's live session.
    it('does not release a session another node holds', async () => {
      const session = await seed();
      await service('node-a').claim(session.id);

      await service('node-b').release(session.id);

      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });

    it('releases everything held, on the way down', async () => {
      const [one, two] = [await seed(), await seed()];
      const nodeA = service('node-a');
      await nodeA.claim(one.id);
      await nodeA.claim(two.id);

      await nodeA.releaseAll();

      expect(nodeA.ownedIds()).toEqual([]);
      expect((await sessions.findOneByOrFail({ id: one.id })).nodeId).toBeNull();
      expect((await sessions.findOneByOrFail({ id: two.id })).nodeId).toBeNull();
    });

    // A start still in flight at shutdown may own a live browser; a peer must not claim under it.
    it('keeps the claims it is told to keep, on the way down', async () => {
      const [one, two] = [await seed(), await seed()];
      const nodeA = service('node-a');
      await nodeA.claim(one.id);
      await nodeA.claim(two.id);

      await nodeA.releaseAll([two.id]);

      expect(nodeA.ownedIds()).toEqual([two.id]);
      expect((await sessions.findOneByOrFail({ id: one.id })).nodeId).toBeNull();
      expect((await sessions.findOneByOrFail({ id: two.id })).nodeId).toBe('node-a');
    });

    // Per-session bookkeeping must end with the claim, or create/delete churn grows it forever.
    it('keeps no per-session state once a claim ends by release, shutdown or loss', async () => {
      const [one, two, three] = [await seed(), await seed(), await seed()];
      const nodeA = service('node-a');
      const claimGen = (nodeA as unknown as { claimGen: Map<string, number> }).claimGen;
      const releasing = (nodeA as unknown as { releasing: Map<string, unknown> }).releasing;
      await nodeA.claim(one.id);
      await nodeA.claim(two.id);
      await nodeA.claim(three.id);

      await nodeA.release(one.id);
      await sessions.update({ id: two.id }, { nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() + 60_000) });
      await nodeA.renew();
      expect([...claimGen.keys()]).toEqual([three.id]);
      expect(releasing.size).toBe(0);

      await nodeA.releaseAll();
      expect(claimGen.size).toBe(0);
      expect(releasing.size).toBe(0);
    });

    // A claim that begins while a release is writing waits for it, so a release that failed must not keep it waiting.
    it('lets a claim begin after a release that failed', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      const releasing = (nodeA as unknown as { releasing: Map<string, unknown> }).releasing;
      await nodeA.claim(session.id);
      const failing = jest.spyOn(sessions, 'createQueryBuilder').mockImplementationOnce(() => {
        throw new Error('database down');
      });

      try {
        await expect(nodeA.release(session.id)).rejects.toThrow('database down');
      } finally {
        failing.mockRestore();
      }
      await expect(nodeA.claim(session.id)).resolves.toBe(true);

      expect(releasing.size).toBe(0);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });
  });

  // A delete ends its claim at the commit that removes the row: the heartbeat must not read the missing row as a loss.
  describe('forgetting a claim whose row was removed', () => {
    it('ends the claim in memory and leaves the database alone', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      const claimGen = (nodeA as unknown as { claimGen: Map<string, number> }).claimGen;
      await nodeA.claim(session.id);

      nodeA.forget(session.id);

      expect(nodeA.ownedIds()).toEqual([]);
      expect(claimGen.size).toBe(0);
      expect((await sessions.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
    });

    it('is not reported as lost by the next tick once the row is gone', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));

      await sessions.delete({ id: session.id });
      nodeA.forget(session.id);
      await nodeA.renew();

      expect(lost).toEqual([]);
    });

    it('is reported as lost when the row goes without the claim being forgotten', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));

      await sessions.delete({ id: session.id });
      await nodeA.renew();

      expect(lost).toEqual([[session.id]]);
    });

    it('ends the claim its caller captured, and only that one', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const captured = nodeA.captureClaim(session.id);
      await nodeA.release(session.id);
      await nodeA.claim(session.id);

      nodeA.forget(session.id, captured);
      expect(nodeA.ownedIds()).toEqual([session.id]);

      nodeA.forget(session.id, nodeA.captureClaim(session.id));
      expect(nodeA.ownedIds()).toEqual([]);
    });
  });

  describe('releasing a lapsed foreign claim', () => {
    // A deliberate teardown of a session whose crashed owner's lease expired must actually leave it
    // down. A row still naming the dead node reads as an abandoned orphan, and the takeover sweep
    // would adopt and restart the session the operator just stopped.
    it('clears a claim whose holder is gone and its lease has lapsed', async () => {
      const session = await seed({ nodeId: 'dead-node', leaseExpiresAt: new Date(Date.now() - 1000) });

      await service('node-b').release(session.id);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBeNull();
      expect(stored.leaseExpiresAt).toBeNull();
    });

    it('leaves a LIVE peer claim untouched — releasing it would strand a running engine', async () => {
      const liveExpiry = new Date(Date.now() + 600_000);
      const session = await seed({ nodeId: 'peer-node', leaseExpiresAt: liveExpiry });

      await service('node-b').release(session.id);

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBe('peer-node');
      expect(stored.leaseExpiresAt!.getTime()).toBe(liveExpiry.getTime());
    });
  });

  describe('renewing', () => {
    it('pushes the expiry out, so a busy node does not lose what it is running', async () => {
      const session = await seed();
      const nodeA = service('node-a', 5_000);
      await nodeA.claim(session.id);
      const first = (await sessions.findOneByOrFail({ id: session.id })).leaseExpiresAt!;

      await new Promise(resolve => setTimeout(resolve, 25));
      await nodeA.renew();

      const renewed = (await sessions.findOneByOrFail({ id: session.id })).leaseExpiresAt!;
      expect(renewed.getTime()).toBeGreaterThan(first.getTime());
    });

    /**
     * A claim whose engine is gone must be allowed to lapse: renewing it unconditionally pinned
     * the session to this node forever — unstartable on any peer, invisible to the takeover sweep.
     * The id stays tracked so the loss is still noticed when a peer takes the row.
     */
    it('skips renewal for a held claim the liveness probe reports dead, so the lease can lapse', async () => {
      const session = await seed();
      const nodeA = service('node-a', 5_000);
      await nodeA.claim(session.id);
      const first = (await sessions.findOneByOrFail({ id: session.id })).leaseExpiresAt!;

      nodeA.setEngineLiveness(() => false);
      await new Promise(resolve => setTimeout(resolve, 25));
      await nodeA.renew();

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.leaseExpiresAt!.getTime()).toBe(first.getTime());
      expect(nodeA.ownedIds()).toContain(session.id);
    });

    it('keeps renewing the claims the liveness probe reports alive', async () => {
      const liveSession = await seed();
      const deadSession = await seed();
      const nodeA = service('node-a', 5_000);
      await nodeA.claim(liveSession.id);
      await nodeA.claim(deadSession.id);
      const firstLive = (await sessions.findOneByOrFail({ id: liveSession.id })).leaseExpiresAt!;
      const firstDead = (await sessions.findOneByOrFail({ id: deadSession.id })).leaseExpiresAt!;

      nodeA.setEngineLiveness(id => id === liveSession.id);
      await new Promise(resolve => setTimeout(resolve, 25));
      await nodeA.renew();

      const live = (await sessions.findOneByOrFail({ id: liveSession.id })).leaseExpiresAt!;
      const dead = (await sessions.findOneByOrFail({ id: deadSession.id })).leaseExpiresAt!;
      expect(live.getTime()).toBeGreaterThan(firstLive.getTime());
      expect(dead.getTime()).toBe(firstDead.getTime());
    });

    /**
     * A node that lost a session must stop extending it. Renewal only writes `leaseExpiresAt`, so
     * the evidence is that value staying put — a stale node refreshing a peer's lease would keep
     * the peer's claim alive on the strength of a process that no longer owns anything.
     */
    it('never renews a session it no longer holds', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      // A peer took over after the lease lapsed; this node still has it in its own set.
      // Deliberately far from the TTL a renewal would write, so an unscoped renew is visible.
      // Matching the TTL would let both land on the same millisecond and read as "unchanged".
      const peerExpiry = new Date(Date.now() + 600_000);
      await sessions.update({ id: session.id }, { nodeId: 'node-b', leaseExpiresAt: peerExpiry });

      await nodeA.renew();

      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.nodeId).toBe('node-b');
      expect(stored.leaseExpiresAt!.getTime()).toBe(peerExpiry.getTime());
    });
  });

  /**
   * The lease only means something if losing it has a consequence. A node can lose one while
   * perfectly healthy — a slow query is enough — after which a peer may legitimately claim the
   * session; an engine left running here would be the second one on that WhatsApp account.
   */
  describe('suspending loss detection', () => {
    /**
     * On SQLite every query runner shares ONE connection, so a heartbeat tick can execute INSIDE a
     * replace-all import's open transaction and see zero session rows — the DELETE has run and the
     * re-inserts have not committed. Concluding loss from that tears down engines that never stopped,
     * and does so even when the import later rolls back and the rows come straight back.
     */
    it('does not conclude loss while an import holds the token', async () => {
      const session = await seed();
      const nodeA = service('node-a', 60_000);
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => {
        lost.push(ids);
      });

      const release = nodeA.suspendLossDetection();
      await sessions.delete({ id: session.id }); // what the import's DELETE looks like from here
      await nodeA.renew();

      expect(lost).toEqual([]);
      expect(nodeA.ownedIds()).toContain(session.id);
      release();
    });

    it('concludes loss again once the token is released', async () => {
      const session = await seed();
      const nodeA = service('node-a', 60_000);
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => {
        lost.push(ids);
      });

      nodeA.suspendLossDetection()();
      await sessions.delete({ id: session.id });
      await nodeA.renew();

      expect(lost).toEqual([[session.id]]);
    });

    it('stays suspended until the LAST overlapping holder releases', async () => {
      const session = await seed();
      const nodeA = service('node-a', 60_000);
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => {
        lost.push(ids);
      });

      const first = nodeA.suspendLossDetection();
      const second = nodeA.suspendLossDetection();
      first();
      await sessions.delete({ id: session.id });
      await nodeA.renew();
      expect(lost).toEqual([]);

      second();
      await nodeA.renew();
      expect(lost).toEqual([[session.id]]);
    });

    it('releasing the same token twice does not resume early', async () => {
      const session = await seed();
      const nodeA = service('node-a', 60_000);
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => {
        lost.push(ids);
      });

      const outer = nodeA.suspendLossDetection();
      const inner = nodeA.suspendLossDetection();
      inner();
      inner(); // a double release must not cancel the outer holder

      await sessions.delete({ id: session.id });
      await nodeA.renew();

      expect(lost).toEqual([]);
      outer();
    });

    /**
     * The re-check must happen AFTER renew()'s awaits, not only at entry: a tick that was already in
     * flight when the import began is exactly the one that observes the emptied table.
     */
    it('neutralises a tick that was already running when the suspension began', async () => {
      const session = await seed();
      const nodeA = service('node-a', 60_000);
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => {
        lost.push(ids);
      });

      // Suspend from inside the query renew() awaits, i.e. after it has already started.
      const realFind = sessions.find.bind(sessions);
      let release: (() => void) | undefined;
      jest.spyOn(sessions, 'find').mockImplementation(async (...args: Parameters<typeof realFind>) => {
        release = nodeA.suspendLossDetection();
        await sessions.delete({ id: session.id });
        return realFind(...args);
      });

      await nodeA.renew();
      jest.restoreAllMocks();

      expect(lost).toEqual([]);
      expect(nodeA.ownedIds()).toContain(session.id);
      release?.();
    });
  });

  describe('losing a claim', () => {
    it('reports the sessions a peer has taken, and stops counting them as its own', async () => {
      const mine = await seed();
      const taken = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(mine.id);
      await nodeA.claim(taken.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));

      // The peer took it after node-a's lease lapsed.
      await sessions.update({ id: taken.id }, { nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() + 60_000) });
      await nodeA.renew();

      expect(lost).toEqual([[taken.id]]);
      expect(nodeA.ownedIds()).toEqual([mine.id]);
    });

    it('says nothing while everything is still held', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));

      await nodeA.renew();

      expect(lost).toEqual([]);
    });

    /**
     * The property that matters most. Concluding loss from a failed query would tear down every
     * healthy engine on this node the first time the database hiccuped — far worse than a renewal
     * arriving late, which the TTL is sized to absorb.
     */
    it('treats a database failure as a late renewal, never as lost ownership', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));
      const find = jest.spyOn(sessions, 'find').mockRejectedValue(new Error('connection reset'));

      await expect(nodeA.renew()).resolves.toBeUndefined();

      expect(lost).toEqual([]);
      expect(nodeA.ownedIds()).toEqual([session.id]);
      find.mockRestore();
    });

    /**
     * Renewal runs on an interval, so a throwing handler would surface as an unhandled rejection
     * and could take the loop down with it — losing every remaining lease as a consequence of one
     * failed teardown.
     */
    it('survives a handler that throws, and still forgets the lost session', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      nodeA.onLeaseLoss(() => {
        throw new Error('teardown exploded');
      });
      await sessions.update({ id: session.id }, { nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() + 60_000) });

      await expect(nodeA.renew()).resolves.toBeUndefined();
      expect(nodeA.ownedIds()).toEqual([]);
    });

    // A stop releases the claim while a tick is in flight: the row no longer names this node, but
    // nothing was lost to a peer, and the lease-loss teardown would leave a stale stop mark.
    it('does not report a session this process released during the tick', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));
      const realFind = sessions.find.bind(sessions);
      jest.spyOn(sessions, 'find').mockImplementation(async (...args: Parameters<typeof realFind>) => {
        await nodeA.release(session.id);
        return realFind(...args);
      });

      await nodeA.renew();
      jest.restoreAllMocks();

      expect(lost).toEqual([]);
    });

    // A stop then a start: the tick read the row between the release and the re-claim. Reporting it
    // lost would drop the fresh claim from `owned` and tear down the engine the start is launching.
    it('does not report a session released and re-claimed during the tick', async () => {
      const session = await seed();
      const nodeA = service('node-a');
      await nodeA.claim(session.id);
      const lost: string[][] = [];
      nodeA.onLeaseLoss(ids => void lost.push(ids));
      const realFind = sessions.find.bind(sessions);
      jest.spyOn(sessions, 'find').mockImplementation(async (...args: Parameters<typeof realFind>) => {
        await nodeA.release(session.id);
        const rows = await realFind(...args);
        await nodeA.claim(session.id);
        return rows;
      });

      await nodeA.renew();
      jest.restoreAllMocks();

      expect(lost).toEqual([]);
      expect(nodeA.ownedIds()).toEqual([session.id]);
    });
  });

  /**
   * Drives an operator-facing warning during a data import: this process can only stop its own
   * engines, so a session running elsewhere has to be named rather than quietly counted as handled.
   */
  describe('is one session held elsewhere', () => {
    it('is true only for a LIVE foreign claim', async () => {
      const live = await seed({ nodeId: 'peer', leaseExpiresAt: new Date(Date.now() + 60_000) });
      const lapsed = await seed({ nodeId: 'peer', leaseExpiresAt: new Date(Date.now() - 1000) });
      const mine = await seed({ nodeId: 'node-a', leaseExpiresAt: new Date(Date.now() + 60_000) });
      const free = await seed();
      const nodeA = service('node-a');

      await expect(nodeA.isHeldByOtherNode(live.id)).resolves.toBe(true);
      // A lapsed holder may be gone — taking over is exactly what the claim rule allows.
      await expect(nodeA.isHeldByOtherNode(lapsed.id)).resolves.toBe(false);
      await expect(nodeA.isHeldByOtherNode(mine.id)).resolves.toBe(false);
      await expect(nodeA.isHeldByOtherNode(free.id)).resolves.toBe(false);
    });

    it('answers the same for a row already loaded, without a query', async () => {
      const live = await seed({ nodeId: 'peer', leaseExpiresAt: new Date(Date.now() + 60_000) });
      const lapsed = await seed({ nodeId: 'peer', leaseExpiresAt: new Date(Date.now() - 1000) });
      const mine = await seed({ nodeId: 'node-a', leaseExpiresAt: new Date(Date.now() + 60_000) });
      const free = await seed();
      const nodeA = service('node-a');
      const loaded = (id: string): Promise<Session> => sessions.findOneByOrFail({ id });

      expect(nodeA.heldByOtherLiveNode(await loaded(live.id))).toBe(true);
      expect(nodeA.heldByOtherLiveNode(await loaded(lapsed.id))).toBe(false);
      expect(nodeA.heldByOtherLiveNode(await loaded(mine.id))).toBe(false);
      expect(nodeA.heldByOtherLiveNode(await loaded(free.id))).toBe(false);
    });
  });

  describe('sessions held elsewhere', () => {
    it('names sessions another node holds on a live lease', async () => {
      const mine = await seed();
      const peers = await seed();
      await service('node-a').claim(mine.id);
      await service('node-b').claim(peers.id);

      await expect(service('node-a').heldByOtherNodes()).resolves.toEqual([peers.id]);
    });

    it('ignores unclaimed sessions and lapsed claims, which nobody is running', async () => {
      await seed();
      await seed({ nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() - 1_000) });

      await expect(service('node-a').heldByOtherNodes()).resolves.toEqual([]);
    });
  });

  describe('lapsed sessions held by others (the takeover sweep feed)', () => {
    it('returns only expired-lease rows held by ANOTHER node', async () => {
      const past = new Date(Date.now() - 1000);
      const future = new Date(Date.now() + 60_000);
      const lapsedOther = await seed({ nodeId: 'dead-node', leaseExpiresAt: past });
      await seed({ nodeId: 'live-node', leaseExpiresAt: future }); // live peer — not adoptable
      await seed({ nodeId: 'me', leaseExpiresAt: past }); // own row — boot reset territory, not takeover
      await seed({ nodeId: null }); // deliberately released (stop/shutdown) — not adoptable

      const lapsed = await service('me').lapsedHeldByOthers();

      expect(lapsed.map(s => s.id)).toEqual([lapsedOther.id]);
    });
  });

  describe('node identity', () => {
    it('falls back to the hostname when nothing is configured, and never to the pid', () => {
      // A pid-derived id would never match after a restart, so a process could not recognise — and
      // therefore could not reset — its own leftover rows.
      const saved = process.env.NODE_ID;
      delete process.env.NODE_ID;
      try {
        expect(new SessionOwnershipService(sessions).nodeId).toBe(hostname());
      } finally {
        if (saved !== undefined) process.env.NODE_ID = saved;
      }
    });
  });

  /**
   * Two processes sharing a nodeId (two instances on one host with no NODE_ID) each treat the other's
   * rows as their own and both keep renewing them, so no loss is ever seen. Only the lease values
   * changing under this process give it away.
   */
  describe('duplicate NODE_ID detection', () => {
    const errorSpy = (svc: SessionOwnershipService): jest.SpyInstance =>
      jest
        .spyOn((svc as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error')
        .mockImplementation(() => undefined);
    const duplicateLogs = (spy: jest.SpyInstance): unknown[][] =>
      (spy.mock.calls as unknown[][]).filter(
        c => (c[2] as { action?: string } | undefined)?.action === 'duplicate_node_id',
      );
    // Each tick lands a second later, so every renewal writes a distinct expiry.
    const tick = async (svc: SessionOwnershipService): Promise<void> => {
      jest.setSystemTime(Date.now() + 1_000);
      await svc.renew();
    };

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('reports twins that both claimed and renew the same row, once each', async () => {
      const session = await seed();
      const twinA = service('node-a');
      const twinB = service('node-a');
      const [logA, logB] = [errorSpy(twinA), errorSpy(twinB)];
      await expect(twinA.claim(session.id)).resolves.toBe(true);
      await expect(twinB.claim(session.id)).resolves.toBe(true);

      for (let k = 0; k < 4; k++) {
        await tick(twinA);
        await tick(twinB);
      }

      expect(duplicateLogs(logA)).toHaveLength(1);
      expect(duplicateLogs(logB)).toHaveLength(1);
      expect(duplicateLogs(logA)[0][2]).toEqual({
        action: 'duplicate_node_id',
        nodeId: 'node-a',
        sessionIds: [session.id],
      });
    });

    it('reports a twin that holds nothing but sees its nodeId renewed by someone else', async () => {
      const session = await seed();
      const owner = service('node-a');
      const idle = service('node-a');
      const log = errorSpy(idle);
      await owner.claim(session.id);

      for (let k = 0; k < 4; k++) {
        await tick(owner);
        await tick(idle);
      }

      expect(duplicateLogs(log)).toHaveLength(1);
    });

    it('stays quiet for a single process renewing its own rows', async () => {
      const session = await seed();
      const node = service('node-a');
      const log = errorSpy(node);
      await node.claim(session.id);

      for (let k = 0; k < 5; k++) await tick(node);

      expect(duplicateLogs(log)).toHaveLength(0);
    });

    it('stays quiet after a one-off rewrite, like a data import carrying a lease forward', async () => {
      const session = await seed();
      const node = service('node-a');
      const log = errorSpy(node);
      await node.claim(session.id);
      await tick(node);
      await sessions.update({ id: session.id }, { leaseExpiresAt: new Date(Date.now() + 45_000) });

      for (let k = 0; k < 4; k++) await tick(node);

      expect(duplicateLogs(log)).toHaveLength(0);
    });

    it("stays quiet for a previous incarnation's lease that nobody renews", async () => {
      await seed({ nodeId: 'node-a', leaseExpiresAt: new Date(Date.now() + 60_000) });
      const fresh = service('node-a');
      const log = errorSpy(fresh);

      for (let k = 0; k < 4; k++) await tick(fresh);

      expect(duplicateLogs(log)).toHaveLength(0);
    });

    it('does not count renewals seen while an import holds the suspension token', async () => {
      const session = await seed();
      const owner = service('node-a');
      const idle = service('node-a');
      const log = errorSpy(idle);
      await owner.claim(session.id);
      const release = idle.suspendLossDetection();

      for (let k = 0; k < 4; k++) {
        await tick(owner);
        await tick(idle);
      }
      expect(duplicateLogs(log)).toHaveLength(0);

      release();
      await tick(owner);
      await tick(idle); // baseline after the suspension
      await tick(owner);
      await tick(idle);
      expect(duplicateLogs(log)).toHaveLength(0);
    });
  });

  describe('PostgreSQL DB-clock lease arithmetic', () => {
    interface CapturedQb {
      kind: 'select' | 'update' | 'unknown';
      setValues?: Record<string, unknown>;
      wheres: Array<{ sql: string; params?: Record<string, unknown> }>;
      params: Record<string, unknown>;
      returning?: string | string[];
    }

    function pgHarness(
      opts: {
        nodeId?: string;
        leaseTtlMs?: number;
        onExecute?: (qb: CapturedQb) => { affected?: number; raw?: unknown };
        onGetMany?: (qb: CapturedQb) => unknown[];
        onGetOne?: (qb?: CapturedQb) => unknown;
        onGetRawOne?: (qb: CapturedQb) => unknown;
        onGetRawMany?: (qb: CapturedQb) => unknown[];
        onGetCount?: (qb: CapturedQb) => number;
        onQuery?: (sql: string) => unknown;
      } = {},
    ) {
      const queries: CapturedQb[] = [];
      const createQueryBuilder = jest.fn(() => {
        const record: CapturedQb = { kind: 'unknown', wheres: [], params: {} };
        queries.push(record);
        const qb: Record<string, jest.Mock> = {};
        qb.update = jest.fn(() => {
          record.kind = 'update';
          return qb;
        });
        qb.select = jest.fn(() => {
          if (record.kind === 'unknown') record.kind = 'select';
          return qb;
        });
        qb.addSelect = jest.fn(() => qb);
        qb.set = jest.fn((values: Record<string, unknown>) => {
          record.setValues = values;
          return qb;
        });
        qb.where = jest.fn((sql: unknown, params?: Record<string, unknown>) => {
          record.wheres.push({ sql: typeof sql === 'string' ? sql : JSON.stringify(sql), params });
          if (params) Object.assign(record.params, params);
          return qb;
        });
        qb.andWhere = jest.fn((sql: unknown, params?: Record<string, unknown>) => {
          record.wheres.push({ sql: typeof sql === 'string' ? sql : JSON.stringify(sql), params });
          if (params) Object.assign(record.params, params);
          return qb;
        });
        qb.setParameter = jest.fn((key: string, value: unknown) => {
          record.params[key] = value;
          return qb;
        });
        qb.setParameters = jest.fn((params: Record<string, unknown>) => {
          Object.assign(record.params, params);
          return qb;
        });
        qb.returning = jest.fn((returning: string | string[]) => {
          record.returning = returning;
          return qb;
        });
        qb.execute = jest.fn(() => Promise.resolve(opts.onExecute?.(record) ?? { affected: 1, raw: [] }));
        qb.getMany = jest.fn(() => Promise.resolve(opts.onGetMany?.(record) ?? []));
        qb.getOne = jest.fn(() => Promise.resolve(opts.onGetOne?.(record) ?? null));
        qb.getRawOne = jest.fn(() => Promise.resolve(opts.onGetRawOne?.(record) ?? null));
        qb.getRawMany = jest.fn(() => Promise.resolve(opts.onGetRawMany?.(record) ?? []));
        qb.getCount = jest.fn(() => Promise.resolve(opts.onGetCount?.(record) ?? 0));
        return qb;
      });
      const repo = {
        manager: {
          connection: { options: { type: 'postgres' } },
          query: jest.fn((sql: string) => Promise.resolve(opts.onQuery?.(sql) ?? [{ now: new Date() }])),
        },
        createQueryBuilder,
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockImplementation(() => Promise.resolve(opts.onGetOne ? opts.onGetOne() : null)),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const svc = new SessionOwnershipService(
        repo as never,
        nodeConfig(opts.nodeId ?? 'node-a', opts.leaseTtlMs ?? 60_000),
      );
      return { svc, repo, queries };
    }

    const renderedSetSql = (qb: CapturedQb): string =>
      Object.values(qb.setValues ?? {})
        .map(v => (typeof v === 'function' ? String((v as () => unknown)()) : ''))
        .join(' | ');

    const allWhereSql = (qb: CapturedQb): string => qb.wheres.map(w => w.sql).join(' AND ');

    const hasDateParam = (qb: CapturedQb): boolean =>
      Object.values(qb.params).some(v => v instanceof Date) ||
      Object.values(qb.setValues ?? {}).some(v => v instanceof Date);

    it('detects postgres dialect and uses DB clock in claimOnce (both new claim with RETURNING and overlapping re-claim)', async () => {
      const dbExpiry1 = new Date('2026-11-22T12:01:00.000Z');
      const { svc, repo, queries } = pgHarness({
        onExecute: () => ({ affected: 1, raw: [{ id: 's1', leaseExpiresAt: dbExpiry1 }] }),
      });

      expect(svc.isPostgres).toBe(true);
      await expect(svc.claim('s1')).resolves.toBe(true);
      const lastSeen = (svc as unknown as { lastSeenLease: Map<string, number> }).lastSeenLease;
      expect(lastSeen.get('s1')).toBe(dbExpiry1.getTime());

      // Overlapping re-claim uses Repository.update with millisecond-truncated DB-clock SQL (zero JS Date).
      await expect(svc.claim('s1')).resolves.toBe(true);

      expect(queries).toHaveLength(1);
      expect(queries[0].kind).toBe('update');
      expect(renderedSetSql(queries[0])).toContain("date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')");
      expect(renderedSetSql(queries[0])).toContain("interval '1 millisecond'");
      expect(queries[0].returning).toBe('"id", "leaseExpiresAt"');
      expect(queries[0].params.ttlMs).toBe(60_000);
      expect(hasDateParam(queries[0])).toBe(false);
      expect(allWhereSql(queries[0])).toContain("date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')");

      expect(repo.update).toHaveBeenCalledTimes(1);
      const [where, patch] = repo.update.mock.calls[0] as [Record<string, unknown>, { leaseExpiresAt: () => string }];
      expect(where).toEqual({ id: 's1', nodeId: 'node-a' });
      expect(typeof patch.leaseExpiresAt).toBe('function');
      expect(patch.leaseExpiresAt()).toContain("date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')");
      expect(patch.leaseExpiresAt()).toContain("60000 * interval '1 millisecond'");
      expect(lastSeen.has('s1')).toBe(false);
    });

    it('uses DB clock in prepareStart and ignores static clock skew between app and DB', async () => {
      const { svc, repo } = pgHarness({});

      await expect(svc.prepareStart('s1', null)).resolves.toBe(true);
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [where, patch] = repo.update.mock.calls[0] as [
        { leaseExpiresAt: { type?: string; getSql?: (alias: string) => string } },
        { desiredState: null; leaseExpiresAt: () => string },
      ];
      expect(where.leaseExpiresAt.type).toBe('raw');
      expect(where.leaseExpiresAt.getSql?.('"leaseExpiresAt"')).toContain(
        "date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')",
      );
      expect(typeof patch.leaseExpiresAt).toBe('function');
      expect(patch.leaseExpiresAt()).toContain("date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')");
      expect(patch.leaseExpiresAt()).toContain("60000 * interval '1 millisecond'");
      expect(patch.desiredState).toBeNull();
    });

    it('uses DB clock in stopExpiredForeignClaim, release/clearRow, lapsedHeldByOthers, isHeldByOtherNode, heldByOtherNodes, findLiveOwner, and hasLiveOwnClaim', async () => {
      const { svc, repo, queries } = pgHarness({
        onExecute: qb => {
          // For release/clearRow: first update (own claim) misses so second update (lapsed foreign) runs.
          if (allWhereSql(qb).includes('"nodeId" = :me') && !allWhereSql(qb).includes('<> :me')) {
            return { affected: 0, raw: [] };
          }
          return { affected: 1, raw: [] };
        },
        onGetOne: () => ({ id: 's1', nodeId: 'peer', nodeUrl: 'http://peer:2785', leaseExpiresAt: new Date(0) }),
        onGetCount: () => 1,
      });

      await expect(svc.stopExpiredForeignClaim('s1')).resolves.toBe(true);
      await svc.release('s1');
      await svc.lapsedHeldByOthers();
      await expect(svc.isHeldByOtherNode('s1')).resolves.toBe(true);
      await svc.heldByOtherNodes();
      await expect(svc.findLiveOwner('s1')).resolves.toMatchObject({ id: 's1', nodeId: 'peer' });
      await expect(svc.hasLiveOwnClaim('s1')).resolves.toBe(true);

      // stopExpiredForeignClaim uses Repository.update with a Raw PG_NOW_UTC predicate (no JS Date).
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [stopWhere] = repo.update.mock.calls[0] as [
        Array<{ leaseExpiresAt: { type?: string; getSql?: (alias: string) => string } }>,
      ];
      expect(stopWhere[1].leaseExpiresAt.type).toBe('raw');
      expect(stopWhere[1].leaseExpiresAt.getSql?.('"leaseExpiresAt"')).toContain(
        "clock_timestamp() AT TIME ZONE 'UTC'",
      );

      // findLiveOwner and hasLiveOwnClaim use Repository.findOne with a Raw PG_NOW_UTC predicate (no JS Date).
      expect(repo.findOne).toHaveBeenCalledTimes(2);
      for (const [opts] of repo.findOne.mock.calls as Array<
        [{ where: { leaseExpiresAt: { type?: string; getSql?: (alias: string) => string } } }]
      >) {
        expect(opts.where.leaseExpiresAt.type).toBe('raw');
        expect(opts.where.leaseExpiresAt.getSql?.('"leaseExpiresAt"')).toContain(
          "clock_timestamp() AT TIME ZONE 'UTC'",
        );
      }

      // Every query builder lease query uses clock_timestamp() AT TIME ZONE 'UTC' and zero Date params.
      const leaseQueries = queries.filter(
        qb =>
          !(qb.kind === 'update' && allWhereSql(qb).includes('"nodeId" = :me') && !allWhereSql(qb).includes('<> :me')),
      );
      expect(leaseQueries.length).toBeGreaterThanOrEqual(4);
      for (const qb of leaseQueries) {
        expect(allWhereSql(qb)).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
        expect(hasDateParam(qb)).toBe(false);
      }

      const claimable = svc.claimableWhere();
      expect(claimable).toHaveLength(3);
      const expiryClause = claimable[2].leaseExpiresAt as { type?: string; getSql?: (alias: string) => string };
      expect(expiryClause.type).toBe('raw');
      expect(expiryClause.getSql?.('"leaseExpiresAt"')).toContain("clock_timestamp() AT TIME ZONE 'UTC'");

      const cutoffOp = svc.expiredBeforeOperator(new Date(Date.now() - 120_000), 120_000) as unknown as {
        type?: string;
        getSql?: (alias: string) => string;
        objectLiteralParameters?: Record<string, unknown>;
      };
      expect(cutoffOp.type).toBe('raw');
      expect(cutoffOp.getSql?.('"leaseExpiresAt"')).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
      expect(cutoffOp.getSql?.('"leaseExpiresAt"')).toContain("interval '1 millisecond'");
      expect(cutoffOp.objectLiteralParameters?.graceMs).toBe(120_000);
    });

    it('keeps noteForeignRenewals quiet on PostgreSQL when node clock is skewed +120s ahead or -120s behind DB time', async () => {
      // Simulate DB clock lagging 120s behind app clock: on each update DB writes dbNow + 60s.
      let dbNow = Date.now() - 120_000;
      let storedExpiry = new Date(dbNow + 60_000);
      const { svc, repo, queries } = pgHarness({
        onGetMany: () => [{ id: 's1', leaseExpiresAt: new Date(storedExpiry.getTime()) }],
        onExecute: () => {
          dbNow += 20_000;
          storedExpiry = new Date(dbNow + 60_000);
          return { affected: 1, raw: [{ id: 's1', leaseExpiresAt: new Date(storedExpiry.getTime()) }] };
        },
      });
      repo.find.mockResolvedValue([{ id: 's1' }]);

      const errorSpy = jest
        .spyOn((svc as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error')
        .mockImplementation(() => undefined);

      await expect(svc.claim('s1')).resolves.toBe(true);
      for (let i = 0; i < 5; i++) {
        await svc.renew();
      }

      const duplicateLogs = errorSpy.mock.calls.filter(
        c => (c[2] as { action?: string } | undefined)?.action === 'duplicate_node_id',
      );
      expect(duplicateLogs).toHaveLength(0);

      // Verify renew SELECT filtered on DB clock and UPDATE used RETURNING with DB clock.
      const selectQueries = queries.filter(q => q.kind === 'select');
      expect(selectQueries.length).toBe(5);
      for (const q of selectQueries) {
        expect(allWhereSql(q)).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
      }
      const updateQueries = queries.filter(q => q.kind === 'update');
      for (const q of updateQueries) {
        expect(q.returning).toBe('"id", "leaseExpiresAt"');
        expect(renderedSetSql(q)).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
        expect(hasDateParam(q)).toBe(false);
      }

      // Now simulate a real twin advancing the DB lease outside this node's writes on 2 consecutive ticks.
      storedExpiry = new Date(storedExpiry.getTime() + 5_000);
      await svc.renew();
      storedExpiry = new Date(storedExpiry.getTime() + 5_000);
      await svc.renew();

      const afterTwin = errorSpy.mock.calls.filter(
        c => (c[2] as { action?: string } | undefined)?.action === 'duplicate_node_id',
      );
      expect(afterTwin).toHaveLength(1);
    });

    it('prepareStart on PostgreSQL treats nullish desiredState as IS NULL and guards elapsed time monotonically', async () => {
      let dateNowCalls = 0;
      const realNow = Date.now.bind(Date);
      // Simulate a +120s wall-clock NTP jump between prepareStart entry and query completion:
      // monotonic performance.now() barely moved, so prepareStart must still admit the engine.
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + ++dateNowCalls * 120_000);

      const { svc, repo } = pgHarness({ leaseTtlMs: 60_000 });

      await expect(svc.prepareStart('s1', undefined as unknown as null)).resolves.toBe(true);
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [where] = repo.update.mock.calls[0] as [
        { desiredState: { type?: string }; leaseExpiresAt: { type?: string; getSql?: (alias: string) => string } },
      ];
      expect(where.desiredState).toMatchObject({ type: 'isNull' });
      expect(where.leaseExpiresAt.type).toBe('raw');
      expect(where.leaseExpiresAt.getSql?.('"leaseExpiresAt"')).toContain(
        "date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')",
      );

      // Conversely, when monotonic elapsed time exceeds leaseTtlMs, prepareStart rejects even if Date.now() stepped backward.
      let perfCall = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => (++perfCall === 1 ? 1_000 : 62_000));
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() - 60_000);

      await expect(svc.prepareStart('s1', null)).resolves.toBe(false);
    });

    it('getDbNow queries clock_timestamp() AT TIME ZONE UTC on PostgreSQL so heldByOtherLiveNode agrees under +120s skew', async () => {
      const realDbNow = new Date('2026-11-22T12:00:00.000Z');
      const { svc, repo } = pgHarness({
        onQuery: () => [{ now: realDbNow }],
      });

      // Local clock skewed +120s ahead of DB time.
      jest.spyOn(Date, 'now').mockReturnValue(realDbNow.getTime() + 120_000);

      const dbNow = await svc.getDbNow();
      expect(repo.manager.query).toHaveBeenCalledWith(expect.stringContaining("clock_timestamp() AT TIME ZONE 'UTC'"));
      expect(dbNow.getTime()).toBe(realDbNow.getTime());

      const peerSession = {
        nodeId: 'peer-node',
        leaseExpiresAt: new Date(realDbNow.getTime() + 60_000),
      };
      // Using DB-fetched now agrees with findLiveOwner despite +120s local clock skew.
      expect(svc.heldByOtherLiveNode(peerSession, dbNow)).toBe(true);
    });
  });
});
