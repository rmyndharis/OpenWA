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
      await nodeA.claim(one.id);
      await nodeA.claim(two.id);
      await nodeA.claim(three.id);

      await nodeA.release(one.id);
      await sessions.update({ id: two.id }, { nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() + 60_000) });
      await nodeA.renew();
      expect([...claimGen.keys()]).toEqual([three.id]);

      await nodeA.releaseAll();
      expect(claimGen.size).toBe(0);
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
});
