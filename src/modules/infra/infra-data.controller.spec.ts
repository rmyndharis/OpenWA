// StorageService (imported transitively by the infra controllers) pulls in `archiver`
// v8, which is ESM-only and cannot be parsed by ts-jest. The controller logic
// under test never touches archiver, so a lightweight stub is sufficient.
jest.mock('archiver', () => ({ default: jest.fn() }));

// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
  };
});

import { DataSource, QueryFailedError } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { InfraDataController, restoreSessionOwnership } from './infra-data.controller';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch, BatchStatus } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('InfraDataController.importData round-trips export-data (no silent message/batch loss)', () => {
  let ds: DataSource;
  let controller: InfraDataController;
  // exportData only reads dataDatabase.type off the config; everything else is unused here.
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };

  const newController = () => new InfraDataController(cfg as never, ds);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
      ],
      synchronize: true,
    });
    await ds.initialize();
    controller = newController();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const seedSession = (id: string) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  it('keeps the session ownership lease across a replace, and never takes it from the payload', async () => {
    await seedSession('s1');
    // Seeded far in the past ON PURPOSE, so the claim is unambiguously LAPSED whatever day the suite
    // runs: a lapsed claim must survive verbatim, because shifting it would resurrect a dead node's
    // hold on the session. (The previous fixture used a same-day stamp, so whether this exercised the
    // lapsed or the live path depended on the wall clock.) The live path is covered below.
    const claimedAt = new Date('2020-01-01T10:00:00.000Z');
    const leaseExpiresAt = new Date('2020-01-01T10:05:00.000Z');
    // A live claim held by THIS node, exactly as SessionOwnershipService would have written it.
    await ds
      .getRepository(Session)
      .update({ id: 's1' }, { nodeId: 'node-a', claimedAt, leaseExpiresAt, nodeUrl: 'http://10.0.0.5:2785' });

    // export-data does SELECT *, so the dump genuinely carries the ownership columns. Rewriting them
    // to a FOREIGN node proves the restore ignores the payload: taking them from the backup would
    // install another host's claim with a still-future lease and 409 every start until it lapsed.
    const dump = await controller.exportData();
    for (const row of dump.tables.sessions as unknown as Record<string, unknown>[]) {
      row.nodeId = 'node-from-another-host';
      row.nodeUrl = 'http://198.51.100.9:2785';
      row.leaseExpiresAt = new Date('2099-01-01T00:00:00.000Z').toISOString();
    }

    const res = await controller.importData({ tables: dump.tables });
    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);

    const restored = await ds.getRepository(Session).findOneByOrFail({ id: 's1' });
    expect(restored.nodeId).toBe('node-a');
    expect(restored.nodeUrl).toBe('http://10.0.0.5:2785');
    expect(new Date(restored.claimedAt as unknown as string).toISOString()).toBe(claimedAt.toISOString());
    expect(new Date(restored.leaseExpiresAt as unknown as string).toISOString()).toBe(leaseExpiresAt.toISOString());
  });

  it('carries LIVE claims forward by their remaining time, including a peer node’s', async () => {
    await seedSession('s1');
    await seedSession('s2');
    const dump = await controller.exportData();

    // Seeded AFTER the export on purpose: the sessions importer writes 12 columns and none of them is
    // ownership, so the dump cannot carry these values — and stamping them here keeps the assertion
    // margin free of the export's cost. That margin is consumed by the import preamble and the
    // commit, NOT by the stall below: a late timer moves the committed lease and `Date.now()` by the
    // same amount, so lengthening the sleep buys nothing.
    const readAt = Date.now();
    // Scaled down from the real 60s TTL so the test costs a second, not a minute — the transaction
    // outliving the remaining time is the property under test, not the size of either number.
    const remainingMs = 1_000;
    await ds.getRepository(Session).update(
      { id: 's1' },
      {
        nodeId: 'node-a',
        claimedAt: new Date(readAt),
        leaseExpiresAt: new Date(readAt + remainingMs),
        nodeUrl: 'http://10.0.0.5:2785',
      },
    );
    // A claim this node does NOT own. The import reads every row with a nodeId, so without the carry
    // it commits a live peer's lease as expired — and `lapsedHeldByOthers` excludes only `nodeId =
    // me`, so the importing node's own takeover sweep is what would then adopt a session whose engine
    // never stopped on the peer.
    await ds.getRepository(Session).update(
      { id: 's2' },
      {
        nodeId: 'node-b',
        claimedAt: new Date(readAt),
        leaseExpiresAt: new Date(readAt + remainingMs * 2),
        nodeUrl: 'http://10.0.0.9:2785',
      },
    );

    // Hold the transaction open past the original expiry, the way a large restore does. Re-binding
    // the stamp verbatim would then commit a lease this request already knows has expired: nodeId
    // still names the live owner, so the row reads as an adoptable orphan to a peer's takeover sweep
    // — a lapse manufactured by the restore, on a claim it observed live moments earlier.
    const realCreate = ds.createQueryRunner.bind(ds);
    let stalled = false;
    jest.spyOn(ds, 'createQueryRunner').mockImplementation(() => {
      const runner = realCreate();
      const realQuery = runner.query.bind(runner) as (...args: unknown[]) => Promise<unknown>;
      runner.query = (async (...args: unknown[]): Promise<unknown> => {
        if (!stalled && typeof args[0] === 'string' && args[0].startsWith('DELETE FROM sessions')) {
          stalled = true;
          await new Promise(resolve => setTimeout(resolve, remainingMs * 1.5));
        }
        return realQuery(...args);
      }) as typeof runner.query;
      return runner;
    });

    const res = await controller.importData({ tables: dump.tables });
    jest.restoreAllMocks();
    expect(res.imported).toBe(true);

    const own = await ds.getRepository(Session).findOneByOrFail({ id: 's1' });
    const peer = await ds.getRepository(Session).findOneByOrFail({ id: 's2' });
    const ownLease = new Date(own.leaseExpiresAt as unknown as string).getTime();
    const peerLease = new Date(peer.leaseExpiresAt as unknown as string).getTime();

    expect(own.nodeId).toBe('node-a');
    expect(peer.nodeId).toBe('node-b');
    // Both still in the future: they were live when read, so they must be live when written back.
    expect(ownLease).toBeGreaterThan(Date.now());
    expect(peerLease).toBeGreaterThan(Date.now());
    // Carried, not renewed: each keeps its OWN remaining time rather than being reset to a full TTL,
    // so the restore extends nobody's hold and the two do not collapse onto the same deadline.
    expect(ownLease).toBeLessThanOrEqual(Date.now() + remainingMs);
    expect(peerLease).toBeGreaterThan(ownLease);
  });

  it('holds the ownership loss-detection token for the whole transaction, and releases it', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    const events: string[] = [];
    let held = 0;
    const ownership = {
      suspendLossDetection: () => {
        held++;
        events.push('suspend');
        return () => {
          held--;
          events.push('release');
        };
      },
      heldByOtherNodes: () => Promise.resolve([]),
    };
    // Observe from inside the transaction: the token must already be held by the time rows move.
    const realCreate = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args: Parameters<typeof realCreate>) => {
      const runner = realCreate(...args);
      const realQuery = runner.query.bind(runner);
      runner.query = ((...callArgs: Parameters<typeof realQuery>) => {
        if (/DELETE FROM sessions/.test(callArgs[0])) events.push(`delete(held=${held})`);
        return realQuery(...callArgs);
      }) as typeof runner.query;
      return runner;
    });

    const withOwnership = new InfraDataController(
      cfg as never,
      ds,
      undefined,
      undefined,
      undefined,
      ownership as never,
    );
    const res = await withOwnership.importData({ tables: dump.tables });
    jest.restoreAllMocks();

    expect(res.imported).toBe(true);
    expect(events).toEqual(['suspend', 'delete(held=1)', 'release']);
    expect(held).toBe(0);
  });

  it('refuses outright when another transaction already holds the connection, before deleting anything', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    // better-sqlite3 hands out a SINGLETON runner, so an import started while a session create or
    // delete holds a transaction becomes a SAVEPOINT inside it: its commit issues RELEASE SAVEPOINT,
    // not COMMIT. The result is genuinely indeterminate — the enclosing transaction may commit (the
    // replace lands) or roll back (it vanishes) — so detecting it afterwards cannot produce a
    // truthful answer, and by then every row is already deleted. Refuse before touching anything.
    const outer = ds.createQueryRunner();
    await outer.connect();
    await outer.startTransaction();

    const refusal = await controller.importData({ tables: dump.tables }).catch((e: unknown) => e);
    expect((refusal as ConflictException).getStatus()).toBe(409);
    // The dashboard decides whether to offer the destructive stop-orphans retry by matching this
    // code positively, so which code this refusal carries is a cross-tier contract, not a detail.
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'IMPORT_NESTED_TRANSACTION' });
    // Asserted alongside the code because `message` is the field the dashboard renders when it
    // withholds the retry — dropping it degrades the operator's toast to a bare "HTTP 409".
    expect((refusal as ConflictException).message).toContain('Another database transaction');

    // The decisive assertion: nothing was destroyed on the way to the refusal.
    const survived = await ds.getRepository(Session).findOneBy({ id: 's1' });
    expect(survived).not.toBeNull();

    await outer.rollbackTransaction();
    await outer.release();
  });

  it('runs normally once no other transaction holds the connection', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    const outer = ds.createQueryRunner();
    await outer.connect();
    await outer.startTransaction();
    await outer.rollbackTransaction();
    await outer.release();

    await expect(controller.importData({ tables: dump.tables })).resolves.toMatchObject({ imported: true });
  });

  it('refuses a second concurrent import instead of letting two share one transaction', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    // Why this matters on the default dialect: BetterSqlite3Driver.createQueryRunner() returns a
    // SINGLETON runner, so two overlapping imports share one transaction. The second startTransaction
    // nests as SAVEPOINT, its commit issues RELEASE SAVEPOINT rather than COMMIT, and a rollback at
    // depth 1 issues a full ROLLBACK — discarding a restore the other call already reported as
    // imported:true.
    //
    // No gating needed to make this deterministic: the first call runs synchronously up to its first
    // await, so the guard must be set before any await for the second call to see it. That ordering
    // is the property under test as much as the 409 is.
    const first = controller.importData({ tables: dump.tables });
    const second = controller.importData({ tables: dump.tables });

    const refusal = await second.catch((e: unknown) => e);
    expect((refusal as ConflictException).getStatus()).toBe(409);
    expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'IMPORT_ALREADY_RUNNING' });
    expect((refusal as ConflictException).message).toContain('already running');
    await expect(first).resolves.toMatchObject({ imported: true });
  });

  it('accepts an import again once the previous one has finished', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    await expect(controller.importData({ tables: dump.tables })).resolves.toMatchObject({ imported: true });
    await expect(controller.importData({ tables: dump.tables })).resolves.toMatchObject({ imported: true });
  });

  it('releases the loss-detection token even when the transaction never opens', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    let held = 0;
    const ownership = {
      suspendLossDetection: () => {
        held++;
        return () => {
          held--;
        };
      },
      heldByOtherNodes: () => Promise.resolve([]),
    };
    // Stubbed rather than provoked: TypeORM nests a second startTransaction as SAVEPOINT, so no
    // dialect here rejects it today. What is pinned is the STRUCTURE — the pre-body span sits
    // outside the release, so any future throw there would strand the token, and a stranded token
    // disables loss detection for the lifetime of the process, silently.
    const realCreate = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args: Parameters<typeof realCreate>) => {
      const runner = realCreate(...args);
      runner.startTransaction = () => Promise.reject(new Error('cannot start a transaction within a transaction'));
      return runner;
    });

    const withOwnership = new InfraDataController(
      cfg as never,
      ds,
      undefined,
      undefined,
      undefined,
      ownership as never,
    );
    await expect(withOwnership.importData({ tables: dump.tables })).rejects.toThrow('within a transaction');
    jest.restoreAllMocks();

    expect(held).toBe(0);
  });

  it('releases the loss-detection token even when the query runner cannot be created', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    let held = 0;
    const ownership = {
      suspendLossDetection: () => {
        held++;
        return () => {
          held--;
        };
      },
      heldByOtherNodes: () => Promise.resolve([]),
    };
    jest.spyOn(ds, 'createQueryRunner').mockImplementation(() => {
      throw new Error('no connection available');
    });

    const withOwnership = new InfraDataController(
      cfg as never,
      ds,
      undefined,
      undefined,
      undefined,
      ownership as never,
    );
    await expect(withOwnership.importData({ tables: dump.tables })).rejects.toThrow('no connection available');
    jest.restoreAllMocks();

    expect(held).toBe(0);
  });

  it('does not suspend loss detection on a dialect where each query runner has its own connection', async () => {
    await seedSession('s1');
    const dump = await controller.exportData();

    let suspends = 0;
    const ownership = {
      suspendLossDetection: () => {
        suspends++;
        return () => {};
      },
      heldByOtherNodes: () => Promise.resolve([]),
    };
    // Postgres hands every runner a dedicated pooled client, so the heartbeat cannot see the
    // import's uncommitted DELETE. Suspending there would disable genuine loss detection in exactly
    // the multi-node deployment that depends on it.
    // Only the pre-transaction suspend decision is under test. Flipping the type also switches off
    // the SQLite `$N`→`?` rewrite, so the import itself is expected to fail — that failure is not
    // what this asserts, and the .catch() below is deliberate rather than defensive.
    const realOptions = ds.options;
    Object.defineProperty(ds, 'options', { value: { ...realOptions, type: 'postgres' }, configurable: true });

    const withOwnership = new InfraDataController(
      cfg as never,
      ds,
      undefined,
      undefined,
      undefined,
      ownership as never,
    );
    await withOwnership.importData({ tables: dump.tables }).catch(() => undefined);
    Object.defineProperty(ds, 'options', { value: realOptions, configurable: true });

    expect(suspends).toBe(0);
  });

  it('rolls the whole import back when ownership cannot be re-applied, instead of reporting success', async () => {
    await seedSession('s1');
    await ds.getRepository(Session).update({ id: 's1' }, { nodeId: 'node-a', nodeUrl: 'http://10.0.0.5:2785' });
    const dump = await controller.exportData();

    // Fail only the ownership UPDATE, leaving every other statement alone. On PostgreSQL a failed
    // statement aborts the transaction, so a caller that degraded this to a notice and committed
    // anyway would have the COMMIT execute as a ROLLBACK and still answer imported:true.
    const realCreate = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args: Parameters<typeof realCreate>) => {
      const runner = realCreate(...args);
      const realQuery = runner.query.bind(runner);
      // Pass EVERY argument through: TypeORM's query builder calls query(sql, params,
      // useStructuredResult) and silently misreads a raw array when the third is dropped.
      runner.query = ((...callArgs: Parameters<typeof realQuery>) =>
        /UPDATE sessions SET "nodeId"/.test(callArgs[0])
          ? Promise.reject(new Error('ownership write failed'))
          : realQuery(...callArgs)) as typeof runner.query;
      return runner;
    });

    const res = await controller.importData({ tables: dump.tables });
    jest.restoreAllMocks();

    expect(res.imported).toBe(false);
    expect(res.warnings.join(' ')).toContain('session ownership');
    // The rollback must have restored the pre-import row, ownership and all.
    const stored = await ds.getRepository(Session).findOneByOrFail({ id: 's1' });
    expect(stored.nodeId).toBe('node-a');
  });

  it('leaves a session that had no claim unclaimed rather than inventing one', async () => {
    await seedSession('s1');

    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);

    const restored = await ds.getRepository(Session).findOneByOrFail({ id: 's1' });
    expect(restored.nodeId).toBeNull();
    expect(restored.leaseExpiresAt).toBeNull();
  });

  it('restores messages and message_batches faithfully — not silently to zero', async () => {
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        waMessageId: 'WA1',
        chatId: 'c1@s.whatsapp.net',
        chatName: 'Support Chat',
        from: 'a@s.whatsapp.net',
        to: 'b@s.whatsapp.net',
        body: 'hello',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1700000000,
        metadata: { ack: 2 },
        status: MessageStatus.DELIVERED,
      }),
    );
    await ds.getRepository(MessageBatch).save(
      ds.getRepository(MessageBatch).create({
        id: 'b1',
        batchId: 'BATCH1',
        sessionId: 's1',
        status: BatchStatus.COMPLETED,
        messages: [{ chatId: 'c1', type: 'text', content: {} }],
        options: null as never,
        progress: null as never,
        results: null as never,
        currentIndex: 0,
        startedAt: null,
        completedAt: null,
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.messages).toBe(1);
    expect(dump.counts.messageBatches).toBe(1);

    const res = await controller.importData({ tables: dump.tables });

    // The whole point of the bug: a valid backup must restore with no warnings and imported:true.
    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.messages).toBe(1);
    expect(res.counts.messageBatches).toBe(1);

    // ...and the rows must actually be present after the DELETE+reinsert, with fields intact.
    expect(await ds.getRepository(Message).count()).toBe(1);
    expect(await ds.getRepository(MessageBatch).count()).toBe(1);
    const m = await ds.getRepository(Message).findOneByOrFail({ id: 'm1' });
    expect(m.body).toBe('hello');
    expect(m.waMessageId).toBe('WA1');
    expect(m.chatName).toBe('Support Chat');
    expect(m.from).toBe('a@s.whatsapp.net');
    expect(m.to).toBe('b@s.whatsapp.net');
    expect(m.metadata).toEqual({ ack: 2 });
    const b = await ds.getRepository(MessageBatch).findOneByOrFail({ id: 'b1' });
    expect(b.batchId).toBe('BATCH1');
    expect(b.status).toBe(BatchStatus.COMPLETED);
  });

  it('round-trips plugin instances + integration delivery failures (Integration Fabric + DLQ)', async () => {
    await seedSession('s1');
    await ds.getRepository(PluginInstance).save(
      ds.getRepository(PluginInstance).create({
        id: 'chatwoot:acct1',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        sessionScope: 's1',
        secret: 'hmac-secret',
        verifyToken: null,
        config: { baseUrl: 'https://x' },
        enabled: true,
      }),
    );
    await ds.getRepository(IntegrationDeliveryFailure).save(
      ds.getRepository(IntegrationDeliveryFailure).create({
        direction: 'outbound',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        sessionId: 's1',
        deliveryId: 'd1',
        attempts: 3,
        lastError: 'boom',
        payload: { foo: 'bar' },
        redriven: false,
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.pluginInstances).toBe(1);
    expect(dump.counts.integrationDeliveryFailures).toBe(1);

    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.pluginInstances).toBe(1);
    expect(res.counts.integrationDeliveryFailures).toBe(1);

    expect(await ds.getRepository(PluginInstance).count()).toBe(1);
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(1);
    const pi = await ds.getRepository(PluginInstance).findOneByOrFail({ id: 'chatwoot:acct1' });
    expect(pi.secret).toBe('hmac-secret'); // ingress HMAC secret survives a SQLite→Postgres migration
    expect(pi.config).toEqual({ baseUrl: 'https://x' });
    const dlf = await ds.getRepository(IntegrationDeliveryFailure).findOneByOrFail({ deliveryId: 'd1' });
    expect(dlf.lastError).toBe('boom');
    expect(dlf.payload).toEqual({ foo: 'bar' });
  });

  // conversation_mappings' map() was never invoked by any prior test — a param transcription slip
  // (e.g. swapping pluginId/instanceId) would leave the whole suite green. Every mapped column gets
  // a distinct value so a swap of any two adjacent params is guaranteed to flip an assertion.
  it('round-trips conversation mappings (handover state survives a restore)', async () => {
    await seedSession('s1');
    const cmRepo = ds.getRepository(ConversationMapping);
    await cmRepo.save(
      cmRepo.create({
        sessionId: 's1',
        chatId: '628111@s.whatsapp.net',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        providerConversationId: 'conv-42',
        handoverState: 'human',
        metadata: { agent: 'alice' },
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.conversationMappings).toBe(1);

    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.conversationMappings).toBe(1);

    const restored = await cmRepo.findOneByOrFail({ chatId: '628111@s.whatsapp.net' });
    expect(restored.sessionId).toBe('s1');
    expect(restored.chatId).toBe('628111@s.whatsapp.net');
    expect(restored.pluginId).toBe('chatwoot');
    expect(restored.instanceId).toBe('acct1');
    expect(restored.providerConversationId).toBe('conv-42');
    expect(restored.handoverState).toBe('human');
    expect(restored.metadata).toEqual({ agent: 'alice' });
  });

  // webhook_delivery_failures' map() was never invoked by any prior test either — same risk as
  // conversation_mappings above. Every mapped column gets a distinct value for the same reason.
  it('round-trips webhook delivery failures (webhook DLQ survives a restore)', async () => {
    await seedSession('s1');
    const wdfRepo = ds.getRepository(WebhookDeliveryFailure);
    await wdfRepo.save(
      wdfRepo.create({
        webhookId: 'w1',
        sessionId: 's1',
        event: 'message',
        url: 'https://example.com/hook',
        idempotencyKey: 'idem-1',
        deliveryId: 'dlv-7',
        attempts: 5,
        lastStatusCode: 502,
        lastError: 'Bad Gateway',
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.webhookDeliveryFailures).toBe(1);

    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.webhookDeliveryFailures).toBe(1);

    const restored = await wdfRepo.findOneByOrFail({ deliveryId: 'dlv-7' });
    expect(restored.webhookId).toBe('w1');
    expect(restored.sessionId).toBe('s1');
    expect(restored.event).toBe('message');
    expect(restored.url).toBe('https://example.com/hook');
    expect(restored.idempotencyKey).toBe('idem-1');
    expect(restored.deliveryId).toBe('dlv-7');
    expect(restored.attempts).toBe(5);
    expect(restored.lastStatusCode).toBe(502);
    expect(restored.lastError).toBe('Bad Gateway');
  });

  it('round-trips the ingress dispatch-lifecycle columns so a restored pending event still replays', async () => {
    await seedSession('s1');
    const ingressRepo = ds.getRepository(IngressEvent);
    // A pending event (still carrying its payload, awaiting reconciler replay) and a retired one
    // (dispatch outcome recorded, payload slimmed to NULL).
    await ingressRepo.save(
      ingressRepo.create({
        id: 'ie-pending',
        instanceId: 'acct1',
        pluginId: 'chatwoot',
        providerDeliveryId: 'dlv-1',
        route: 'chatwoot/acct1',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        payloadHash: 'abc123',
        sessionId: 's1',
        dispatchState: 'pending',
        dispatchAttempts: 2,
        lastDispatchAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    );
    await ingressRepo.save(
      ingressRepo.create({
        id: 'ie-retired',
        instanceId: 'acct1',
        pluginId: 'chatwoot',
        providerDeliveryId: 'dlv-2',
        route: 'chatwoot/acct1',
        payload: null,
        payloadHash: 'def456',
        sessionId: 's1',
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        lastDispatchAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    );

    const dump = await controller.exportData();
    expect(dump.counts.ingressEvents).toBe(2);

    await ingressRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.ingressEvents).toBe(2);

    // A restored 'pending' row that lost its dispatchState would read as NULL ("not watched"): the
    // reconciler would never replay it while the dedup key still blocked the provider's retry.
    const pending = await ingressRepo.findOneByOrFail({ id: 'ie-pending' });
    expect(pending.dispatchState).toBe('pending');
    expect(pending.dispatchAttempts).toBe(2);
    expect(pending.lastDispatchAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
    expect(pending.payloadHash).toBe('abc123');
    expect(pending.payload).toEqual({ headers: {}, query: {}, body: '{}', rawBody: '{}' });
    // These columns were never pinned before — the map() param order is the whole point of the
    // descriptor, and each value here is distinct so a swap of any two adjacent params fails.
    expect(pending.instanceId).toBe('acct1');
    expect(pending.pluginId).toBe('chatwoot');
    expect(pending.providerDeliveryId).toBe('dlv-1');
    expect(pending.route).toBe('chatwoot/acct1');
    expect(pending.sessionId).toBe('s1');

    const retired = await ingressRepo.findOneByOrFail({ id: 'ie-retired' });
    expect(retired.dispatchState).toBe('dispatched');
    expect(retired.payloadHash).toBe('def456');
    expect(retired.providerDeliveryId).toBe('dlv-2');
    // A retired payload must stay NULL — re-materializing it as '{}' would make the slimmed dedup
    // row read as a pending event with an empty body.
    expect(retired.payload).toBeNull();
  });

  it('imports a pre-lifecycle backup (no dispatch columns) as not-watched legacy rows', async () => {
    await seedSession('s1');
    const res = await controller.importData({
      tables: {
        ingressEvents: [
          {
            id: 'ie-legacy',
            instanceId: 'acct1',
            pluginId: 'chatwoot',
            providerDeliveryId: 'dlv-9',
            route: 'chatwoot/acct1',
            payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
            sessionId: 's1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ] as never,
      },
    });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    // Columns absent from an older backup import as NULL/0 — the same "not watched" reading legacy
    // rows have by design (the reconciler never sweeps them, so an upgrade can't mass-replay history).
    const legacy = await ds.getRepository(IngressEvent).findOneByOrFail({ id: 'ie-legacy' });
    expect(legacy.dispatchState).toBeNull();
    expect(legacy.dispatchAttempts).toBe(0);
    expect(legacy.lastDispatchAt).toBeNull();
    expect(legacy.payloadHash).toBeNull();
  });

  it('rolls back and reports imported:false when a row fails — existing data is preserved', async () => {
    // Pre-existing data that must survive a failed import.
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        waMessageId: 'WA1',
        chatId: 'c1',
        from: 'a',
        to: 'b',
        body: 'keep me',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      }),
    );

    // A backup whose message row is malformed (missing the non-null from/to) must fail the whole import.
    const res = await controller.importData({
      tables: {
        sessions: [{ id: 's2', name: 'imported', status: 'ready' }] as never,
        messages: [
          { id: 'mX', sessionId: 's2', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ] as never,
      },
    });

    expect(res.imported).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);

    // The destructive DELETE must have been rolled back — original data intact, nothing from the bad import.
    expect(await ds.getRepository(Message).count()).toBe(1);
    expect((await ds.getRepository(Message).findOneByOrFail({ id: 'm1' })).body).toBe('keep me');
    expect(await ds.getRepository(Session).findOneBy({ id: 's2' })).toBeNull();
  });

  it('refuses an empty/garbage backup — does not wipe existing data (#488 review must-fix)', async () => {
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        chatId: 'c1',
        from: 'a',
        to: 'b',
        body: 'keep me',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      }),
    );

    // A wrong/empty file (no rows to restore) must NOT commit the all-rows DELETE and report success.
    const res = await controller.importData({ tables: {} });

    expect(res.imported).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(await ds.getRepository(Session).count()).toBe(1);
    expect(await ds.getRepository(Message).count()).toBe(1);
  });

  it('propagates a genuine clear-table failure (lock/IO) instead of committing a merged restore', async () => {
    // Pre-existing data that must survive if a clear step fails.
    await seedSession('s1');
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        id: 'm1',
        sessionId: 's1',
        chatId: 'c1',
        from: 'a',
        to: 'b',
        body: 'keep me',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
      }),
    );

    expect(await ds.getRepository(Message).count()).toBe(1); // sanity: seeded

    // Make ONLY `DELETE FROM messages` fail with a genuine (non-missing-table) error. Previously a
    // blind `.catch(() => {})` swallowed this and let a disjoint-id backup COMMIT a merged (not
    // replaced) restore on SQLite; scoping the swallow to missing-table means the failure must now
    // SURFACE (reaching the existing rollback-and-rethrow catch). A Proxy over the runner the
    // controller creates intercepts just that one statement — no spy on `query`, so TypeORM's own
    // internal `this.query` transaction control (BEGIN/ROLLBACK) is untouched.
    const lockErr = new QueryFailedError(
      'DELETE FROM messages',
      [],
      Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }),
    );
    let rolledBack = false;
    const origCreate = ds.createQueryRunner.bind(ds);
    jest.spyOn(ds, 'createQueryRunner').mockImplementation(() => {
      const real = origCreate();
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'query') {
            return (sql: string, params?: unknown[]) =>
              sql === 'DELETE FROM messages'
                ? Promise.reject(lockErr)
                : (target.query as (q: string, p?: unknown[]) => Promise<unknown>).call(target, sql, params);
          }
          if (prop === 'rollbackTransaction') {
            return async () => {
              rolledBack = true;
              return target.rollbackTransaction.call(target);
            };
          }
          const val = (target as unknown as Record<string, unknown>)[prop as string];
          return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
        },
      });
    });

    await expect(controller.importData({ tables: { messages: [] } })).rejects.toThrow(/database is locked/);
    expect(rolledBack).toBe(true);

    jest.restoreAllMocks();
  });
});

describe('InfraDataController.import/export preserves every data-DB table', () => {
  let ds: DataSource;
  let controller: InfraDataController;
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  const newController = () => new InfraDataController(cfg as never, ds);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, Message, MessageBatch, Template, BaileysStoredMessage, LidMapping],
      synchronize: true,
    });
    await ds.initialize();
    controller = newController();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const seedSession = (id: string) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  // lid_mappings is the persisted lid->phone cache; it is NOT a FK to sessions, so the sessions DELETE
  // never touches it — but export omitted it, so a backup→restore into a fresh DB dropped it entirely.
  it('restores lid_mappings instead of dropping them on a backup→restore', async () => {
    await seedSession('s1');
    const lidRepo = ds.getRepository(LidMapping);
    await lidRepo.save(lidRepo.create({ lid: '111', phone: '628111', sessionId: 's1' }));
    await lidRepo.save(lidRepo.create({ lid: '222', phone: null, sessionId: 's1' })); // negative cache

    const dump = await controller.exportData();
    expect((dump.tables as unknown as { lidMappings?: unknown[] }).lidMappings).toHaveLength(2);

    // Simulate restoring into a fresh data DB (the documented backend-migration flow).
    await lidRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(await lidRepo.count()).toBe(2);
    expect((await lidRepo.findOneByOrFail({ lid: '111' })).phone).toBe('628111');
    expect((await lidRepo.findOneByOrFail({ lid: '222' })).phone).toBeNull();
  });

  // The messages import column list must carry every later-added column; `author` (the group
  // sender identity) was the one that drifted — a restored backup silently lost all attribution.
  it('restores the group-sender author column on a backup→restore', async () => {
    await seedSession('s1');
    const msgRepo = ds.getRepository(Message);
    await msgRepo.save(
      msgRepo.create({
        sessionId: 's1',
        waMessageId: 'WA-A1',
        chatId: '120363@g.us',
        chatName: 'Alice',
        author: '628111@c.us',
        from: '120363@g.us',
        to: 'me@c.us',
        body: 'hello',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: 1700000000,
      }),
    );

    const dump = await controller.exportData();
    await msgRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    const restored = await msgRepo.findOneByOrFail({ waMessageId: 'WA-A1' });
    expect(restored.author).toBe('628111@c.us');
  });

  // Same drift, next column along. These two matter more than most: the archived media FILES ride
  // along in the storage export, so restoring rows without their pointers leaves every file
  // referenced by nothing — and the chat-media orphan sweep deletes exactly that after its grace
  // window. The loss would surface hours after a restore that reported success.
  it('restores the chat-media archive pointers on a backup→restore', async () => {
    await seedSession('s1');
    const msgRepo = ds.getRepository(Message);
    await msgRepo.save(
      msgRepo.create({
        sessionId: 's1',
        waMessageId: 'WA-M1',
        chatId: '628111@c.us',
        from: '628111@c.us',
        to: 'me@c.us',
        body: '',
        type: 'image',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: 1700000000,
        mediaPath: 'chat-media/s1/1f0c8f4e-0000-4000-8000-000000000000.png',
        mediaMimetype: 'image/png',
      }),
    );

    const dump = await controller.exportData();
    await msgRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    const restored = await msgRepo.findOneByOrFail({ waMessageId: 'WA-M1' });
    expect(restored.mediaPath).toBe('chat-media/s1/1f0c8f4e-0000-4000-8000-000000000000.png');
    expect(restored.mediaMimetype).toBe('image/png');
  });

  // DELETE FROM sessions cascades to templates + baileys_stored_messages (both FK ON DELETE CASCADE),
  // so an import that never re-inserts them permanently wipes both on the documented backup flow.
  it('restores templates and baileys_stored_messages instead of cascade-wiping them', async () => {
    await seedSession('s1');
    await ds
      .getRepository(Template)
      .save(ds.getRepository(Template).create({ id: 't1', sessionId: 's1', name: 'greet', body: 'Hi {{name}}' }));
    await ds.getRepository(BaileysStoredMessage).save(
      ds.getRepository(BaileysStoredMessage).create({
        id: 'bsm1',
        sessionId: 's1',
        waMessageId: 'WA1',
        serializedMessage: '{"k":"v"}',
      }),
    );

    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(await ds.getRepository(Template).count()).toBe(1);
    expect(await ds.getRepository(BaileysStoredMessage).count()).toBe(1);
    expect((await ds.getRepository(Template).findOneByOrFail({ id: 't1' })).body).toBe('Hi {{name}}');
    expect((await ds.getRepository(BaileysStoredMessage).findOneByOrFail({ id: 'bsm1' })).serializedMessage).toBe(
      '{"k":"v"}',
    );
  });

  // The webhooks INSERT omitted the `filters` column, so a filtered webhook came back firing on
  // every event after a restore (over-delivery / PII fan-out).
  it('preserves webhook filters across a round-trip', async () => {
    await seedSession('s1');
    await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        id: 'w1',
        sessionId: 's1',
        url: 'https://example.com/hook',
        events: ['message'],
        secret: null,
        headers: {},
        active: true,
        retryCount: 3,
        filters: { conditions: [{ field: 'sender', operator: 'equals', value: '123@c.us' }] },
      }),
    );

    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.imported).toBe(true);
    expect((await ds.getRepository(Webhook).findOneByOrFail({ id: 'w1' })).filters).toEqual({
      conditions: [{ field: 'sender', operator: 'equals', value: '123@c.us' }],
    });
    // The active flag (exported as integer 1 from SQLite) must round-trip as a real boolean.
    expect((await ds.getRepository(Webhook).findOneByOrFail({ id: 'w1' })).active).toBe(true);
  });
});

describe('InfraDataController C002 audit trail — import emits only on a committed restore', () => {
  let ds: DataSource;
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  const build = (audit: { logInfo: jest.Mock }): InfraDataController =>
    new InfraDataController(cfg as never, ds, audit as never);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
      ],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const seedSession = (id: string) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  it('emits INFRA_DATA_EXPORTED then INFRA_DATA_IMPORTED across a successful round-trip', async () => {
    await seedSession('s1');
    const audit = { logInfo: jest.fn().mockResolvedValue(null) };
    const controller = build(audit);
    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);
    const actions = (audit.logInfo.mock.calls as Array<[AuditAction, unknown]>).map(c => c[0]);
    expect(actions).toContain(AuditAction.INFRA_DATA_EXPORTED);
    expect(actions).toContain(AuditAction.INFRA_DATA_IMPORTED);
  });

  it('does NOT emit INFRA_DATA_IMPORTED when an empty backup is refused (no data changed)', async () => {
    await seedSession('s1');
    const audit = { logInfo: jest.fn().mockResolvedValue(null) };
    const res = await build(audit).importData({ tables: {} });
    expect(res.imported).toBe(false);
    const actions = (audit.logInfo.mock.calls as Array<[AuditAction, unknown]>).map(c => c[0]);
    expect(actions).not.toContain(AuditAction.INFRA_DATA_IMPORTED);
  });
});

describe('InfraDataController.exportData optional-table strictness', () => {
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
  const build = (query: jest.Mock) => new InfraDataController(cfg as never, { query } as never);

  it('rethrows a non-missing-table error (lock/IO/timeout) instead of reporting a partial export as complete', async () => {
    // A lock on ONE optional table must fail the whole export: silently exporting without that table
    // produces a backup the import then treats as authoritative, DELETing the table's existing rows.
    const query = jest.fn((sql: string) =>
      sql === 'SELECT * FROM messages'
        ? Promise.reject(new Error('SQLITE_BUSY: database is locked'))
        : Promise.resolve([]),
    );
    await expect(build(query).exportData()).rejects.toThrow(/database is locked/);
  });

  it('tolerates a genuinely absent optional table — and marks it in skippedTables', async () => {
    const missing = Object.assign(new Error('no such table: messages'), { name: 'SqliteError' });
    const query = jest.fn((sql: string) =>
      sql === 'SELECT * FROM messages' ? Promise.reject(missing) : Promise.resolve([]),
    );
    const dump = await build(query).exportData();
    expect(dump.counts.messages).toBe(0);
    expect(dump.tables.messages).toEqual([]);
    expect(dump.skippedTables).toContain('messages');
    // Every other table still exported (all empty here, none skipped).
    expect(dump.skippedTables).toEqual(['messages']);
  });

  it('strips the Postgres generated body_ts tsvector from exported message rows', async () => {
    // Postgres' STORED generated FTS column rides along in `SELECT *`; it is an index artifact, not
    // payload, and must not be serialized into a (dialect-neutral) backup.
    const messageRow = {
      id: 'm1',
      sessionId: 's1',
      waMessageId: 'WA1',
      chatId: 'c1',
      chatName: null,
      author: null,
      from: 'a',
      to: 'b',
      body: 'hello',
      type: 'text',
      direction: 'incoming',
      timestamp: 1700000000,
      metadata: null,
      status: 'delivered',
      createdAt: '2026-01-01T00:00:00.000Z',
      body_ts: "'hello'",
    };
    const query = jest.fn((sql: string) => Promise.resolve(sql === 'SELECT * FROM messages' ? [messageRow] : []));
    const dump = await build(query).exportData();
    expect(dump.tables.messages).toHaveLength(1);
    expect(dump.tables.messages[0]).not.toHaveProperty('body_ts');
    expect(dump.tables.messages[0].body).toBe('hello');
  });
});

describe('InfraDataController.importData status_updates + runtime reconciliation', () => {
  let ds: DataSource;
  const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };

  // Positional constructor: (config, dataDs, auditService?, sessionService?, lidMappingStore?).
  // The @Optional args trail the required ones; auditService is unused in these tests, so its slot
  // stays undefined.
  const build = (opts: { sessionService?: unknown; lidMappingStore?: unknown } = {}) =>
    new InfraDataController(cfg as never, ds, undefined, opts.sessionService as never, opts.lidMappingStore as never);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
        StatusUpdate,
        AutomationRule,
      ],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const seedSession = (id: string) =>
    ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id,
        name: `session-${id}`,
        status: SessionStatus.READY,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );

  // automation_rules FKs sessions ON DELETE CASCADE, so the import's `DELETE FROM sessions` takes
  // every rule with it — on SQLite too, where better-sqlite3 enforces foreign keys. Without export +
  // re-insert the documented backup/restore silently destroyed every autoreply rule.
  it('exports and restores automation_rules, which the session wipe would otherwise cascade away', async () => {
    await seedSession('s1');
    const ruleRepo = ds.getRepository(AutomationRule);
    await ruleRepo.save(
      ruleRepo.create({
        id: 'rule-1',
        sessionId: 's1',
        name: 'office hours',
        enabled: true,
        conditions: { bodyContains: ['hello'] } as never,
        replyText: 'We are closed',
        cooldownSeconds: 120,
      }),
    );

    const controller = build();
    const dump = await controller.exportData();
    expect(dump.counts.automationRules).toBe(1);
    expect(dump.skippedTables).toEqual([]);

    const res = await controller.importData({ tables: dump.tables });

    expect(res.imported).toBe(true);
    expect(res.counts.automationRules).toBe(1);
    const restored = await ruleRepo.findOneByOrFail({ id: 'rule-1' });
    expect(restored.replyText).toBe('We are closed');
    expect(restored.cooldownSeconds).toBe(120);
    expect(restored.enabled).toBe(true);
    expect(restored.conditions).toEqual({ bodyContains: ['hello'] });
  });

  it('exports and restores status_updates (the table the docs promise is covered)', async () => {
    await seedSession('s1');
    const statusRepo = ds.getRepository(StatusUpdate);
    await statusRepo.save(
      statusRepo.create({
        id: 'su1',
        sessionId: 's1',
        contactJid: '628111@c.us',
        contactName: 'Alice',
        contactPushName: 'alice',
        waStatusId: 'false_status@broadcast_ABC',
        type: 'text',
        caption: 'on vacation',
        mediaOmitted: true,
        omitReason: 'over_cap',
        backgroundColor: '#FF0000',
        font: 2,
        postedAt: 1750000000000,
        expiresAt: 1750086400000,
      }),
    );

    const controller = build();
    const dump = await controller.exportData();
    expect(dump.counts.statusUpdates).toBe(1);
    expect(dump.skippedTables).toEqual([]);

    await statusRepo.clear();
    const res = await controller.importData({ tables: dump.tables });

    expect(res.warnings).toEqual([]);
    expect(res.imported).toBe(true);
    expect(res.counts.statusUpdates).toBe(1);
    const restored = await statusRepo.findOneByOrFail({ id: 'su1' });
    expect(restored.waStatusId).toBe('false_status@broadcast_ABC');
    expect(restored.caption).toBe('on vacation');
    expect(restored.mediaOmitted).toBe(true); // boolean survives the 0/1 round-trip
    expect(restored.omitReason).toBe('over_cap');
    expect(restored.font).toBe(2);
    expect(restored.postedAt).toBe(1750000000000);
    expect(restored.expiresAt).toBe(1750086400000);
    // These columns were never pinned before — the map() param order is the whole point of the
    // descriptor, and each value here is distinct so a swap of any two adjacent params fails.
    expect(restored.sessionId).toBe('s1');
    expect(restored.contactJid).toBe('628111@c.us');
    expect(restored.contactName).toBe('Alice');
    expect(restored.contactPushName).toBe('alice');
    expect(restored.type).toBe('text');
    expect(restored.backgroundColor).toBe('#FF0000');
  });

  it('tolerates body_ts on imported message rows (backup made before the strip)', async () => {
    await seedSession('s1');
    const res = await build().importData({
      tables: {
        sessions: [
          {
            id: 's1',
            name: 'session-s1',
            status: 'ready',
            config: '{}',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ] as never,
        messages: [
          {
            id: 'm1',
            sessionId: 's1',
            waMessageId: 'WA1',
            chatId: 'c1',
            from: 'a',
            to: 'b',
            body: 'hello',
            type: 'text',
            direction: 'incoming',
            status: 'delivered',
            createdAt: '2026-01-01T00:00:00.000Z',
            body_ts: "'hello'", // legacy Postgres export artifact — must be ignored, not fail
          },
        ] as never,
      },
    });
    expect(res.imported).toBe(true);
    expect(res.warnings).toEqual([]);
    expect((await ds.getRepository(Message).findOneByOrFail({ id: 'm1' })).body).toBe('hello');
  });

  it('reloads the in-memory lid mappings after a committed restore', async () => {
    await seedSession('s1');
    const lidMappingStore = { reload: jest.fn().mockResolvedValue(undefined) };
    const controller = build({ lidMappingStore });
    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);
    expect(lidMappingStore.reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT reload lid mappings when the import is refused (nothing committed)', async () => {
    await seedSession('s1');
    const lidMappingStore = { reload: jest.fn().mockResolvedValue(undefined) };
    const res = await build({ lidMappingStore }).importData({ tables: {} });
    expect(res.imported).toBe(false);
    expect(lidMappingStore.reload).not.toHaveBeenCalled();
  });

  it('409s when a live engine would be orphaned by the replace — unless force=true', async () => {
    await seedSession('s1');
    const controller = build({ sessionService: { getActiveSessionIds: () => ['ghost'] } });
    const dump = await controller.exportData(); // backup contains only s1, not the running 'ghost'

    // Without force: 409 Conflict, and the destructive replace never started.
    const err = await controller.importData({ tables: dump.tables }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).message).toContain('ghost');
    // This is the ONLY refusal on this route whose documented retry (stopOrphans=true) is a real
    // decision the operator can act on, and it is the only one the dashboard may offer a destructive
    // retry for. It carries its own code so that identification is positive: an unrecognised code and
    // a 409 that never reached this method both fail closed instead of opening the confirm.
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'IMPORT_WOULD_ORPHAN_ENGINES' });
    expect(await ds.getRepository(Session).count()).toBe(1); // nothing deleted

    // With force: the restore proceeds and the response tells the operator a restart is required
    // to stop the orphaned engine.
    const res = await controller.importData({ tables: dump.tables, force: true });
    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(true);
    expect(res.orphanedEngines).toEqual(['ghost']);
  });

  it('reports restartRequired:false when no live engine is orphaned', async () => {
    await seedSession('s1');
    const controller = build({ sessionService: { getActiveSessionIds: () => ['s1'] } });
    const dump = await controller.exportData();
    const res = await controller.importData({ tables: dump.tables });
    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(false);
    expect(res.orphanedEngines).toEqual([]);
  });

  it('stopOrphans=true stops the orphan engines inside the request and keeps restartRequired:false', async () => {
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['ghost'], notRunning: [], failed: [] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['ghost'], stopOrphanEngines },
    });
    const dump = await controller.exportData(); // backup contains only s1, not 'ghost'

    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });

    // The orphan engines were stopped (called once with exactly the orphan ids) and the import
    // proceeded without requiring a restart — the whole point of stopOrphans vs force.
    expect(stopOrphanEngines).toHaveBeenCalledWith(['ghost']);
    expect(stopOrphanEngines).toHaveBeenCalledTimes(1);
    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(false);
    expect(res.stoppedOrphanEngines).toEqual(['ghost']);
    expect(res.failedOrphanEngines).toEqual([]);
    expect(res.orphanedEngines).toEqual(['ghost']);
  });

  it('still reports the engines it already stopped when the import rolls back', async () => {
    // The pre-flight teardown runs BEFORE the transaction opens and cannot be rolled back with it.
    // An operator reading imported:false plus empty orphan arrays would conclude nothing happened,
    // while their sessions are actually down.
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['ghost'], notRunning: [], failed: [] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['ghost'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    // A message row missing the non-null from/to fails mid-import and forces the all-or-nothing rollback.
    const res = await controller.importData({
      tables: {
        ...dump.tables,
        messages: [
          { id: 'mX', sessionId: 's1', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ] as never,
      },
      stopOrphans: true,
    });

    expect(res.imported).toBe(false); // the DB really did roll back
    expect(stopOrphanEngines).toHaveBeenCalledWith(['ghost']); // ...but the teardown really did happen
    expect(res.stoppedOrphanEngines).toEqual(['ghost']);
    expect(res.orphanedEngines).toEqual(['ghost']);
    expect(res.restartRequired).toBe(false); // sessions survive the rollback; restart them via the API
  });

  it('flags restartRequired on a rolled-back import whose orphan teardown failed', async () => {
    // The failed teardown is the one irreversible thing a rollback cannot undo: the Chromium/socket
    // may still be alive, so this must stay true even though no data changed.
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: [], notRunning: [], failed: ['ghost'] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['ghost'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    const res = await controller.importData({
      tables: {
        ...dump.tables,
        messages: [
          { id: 'mX', sessionId: 's1', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ] as never,
      },
      stopOrphans: true,
    });

    expect(res.imported).toBe(false);
    expect(res.restartRequired).toBe(true);
    expect(res.failedOrphanEngines).toEqual(['ghost']);
  });

  it('stopOrphans=true surfaces a teardown failure as restartRequired:true + a warning (Map reconciled regardless)', async () => {
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['g1'], notRunning: [], failed: ['g2'] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['g1', 'g2'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });

    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(true);
    expect(res.failedOrphanEngines).toEqual(['g2']);
    expect(res.stoppedOrphanEngines).toEqual(['g1']);
    expect(res.notices.some(w => w.includes('g2') && w.includes('restart'))).toBe(true);
  });

  it('stopOrphans=true reports notRunning orphans (still initializing) as a warning', async () => {
    await seedSession('s1');
    const stopOrphanEngines = jest.fn().mockResolvedValue({ stopped: ['g1'], notRunning: ['g-init'], failed: [] });
    const controller = build({
      sessionService: { getActiveSessionIds: () => ['g1', 'g-init'], stopOrphanEngines },
    });
    const dump = await controller.exportData();

    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });

    expect(res.imported).toBe(true);
    expect(res.restartRequired).toBe(false);
    expect(res.notices.some(w => w.includes('g-init') && w.includes('initializing'))).toBe(true);
  });

  it('stopOrphans=true is a no-op when there is no sessionService wired', async () => {
    // Some stripped-down module shapes may not import SessionModule; the controller must not throw
    // when stopOrphans is requested but the service is unavailable — it falls back to refuse/force.
    await seedSession('s1');
    const controller = build({}); // no sessionService
    const dump = await controller.exportData();

    // Without sessionService there are no active ids to detect, so no orphan, no 409 — the import
    // proceeds normally. (This matches the @Optional() wiring; the gate only engages when the
    // service is present.)
    const res = await controller.importData({ tables: dump.tables, stopOrphans: true });
    expect(res.imported).toBe(true);
    expect(res.stoppedOrphanEngines).toEqual([]);
  });
});

// C002: the infra module exposed sensitive ADMIN operations (credential config write, restart/Docker
// orchestration, full-DB + storage export/import) with no audit trail. Each now emits an AuditAction.
describe('InfraDataController C002 audit trail (light-dependency handlers)', () => {
  const makeAudit = (): { logInfo: jest.Mock } => ({ logInfo: jest.fn().mockResolvedValue(null) });

  // Positional constructor: (config, dataDs, auditService?, sessionService?, lidMappingStore?).
  // auditService is the first trailing @Optional arg.
  const build = (
    audit: { logInfo: jest.Mock },
    overrides: Partial<{
      config: unknown;
      dataDs: unknown;
    }> = {},
  ): InfraDataController =>
    new InfraDataController((overrides.config ?? {}) as never, (overrides.dataDs ?? {}) as never, audit as never);

  it('exportData emits INFRA_DATA_EXPORTED with per-table counts', async () => {
    const audit = makeAudit();
    const controller = build(audit, {
      config: { get: (k: string, d?: unknown) => (k === 'dataDatabase.type' ? 'sqlite' : d) },
      dataDs: { query: jest.fn().mockResolvedValue([]) },
    });
    await controller.exportData();
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { counts: { sessions: number } } }]>;
    expect(calls[0][0]).toBe(AuditAction.INFRA_DATA_EXPORTED);
    expect(calls[0][1].metadata.counts.sessions).toBe(0);
  });
});

describe('restoreSessionOwnership', () => {
  const claim = { id: 's1', nodeId: 'node-a', claimedAt: 'c', leaseExpiresAt: 'l', nodeUrl: 'u' };

  it('propagates a failure instead of swallowing it, so the caller can roll the import back', async () => {
    // Swallowing it would be worse than the bug: on PostgreSQL a failed statement aborts the
    // transaction, so the COMMIT that followed would execute as a ROLLBACK and the endpoint would
    // report a fully discarded import as a success.
    await expect(
      restoreSessionOwnership([claim], () => Promise.reject(new Error('db went away')), new Date()),
    ).rejects.toThrow('db went away');
  });

  it('does nothing when there is no ownership to carry', async () => {
    const calls: unknown[][] = [];
    const insert = (_sql: string, params: unknown[]): Promise<unknown> => {
      calls.push(params);
      return Promise.resolve();
    };

    await restoreSessionOwnership(null, insert, new Date());
    await restoreSessionOwnership([], insert, new Date());

    expect(calls).toEqual([]);
  });

  it('binds the values it read, never values from the payload', async () => {
    const bound: unknown[][] = [];
    const statements: string[] = [];
    const insert = (sql: string, params: unknown[]): Promise<unknown> => {
      statements.push(sql);
      bound.push(params);
      return Promise.resolve();
    };

    await restoreSessionOwnership([claim], insert, new Date());

    // 'l' is not a parseable deadline, so it is written back untouched: a value this function cannot
    // interpret is not one it may rewrite.
    expect(bound).toEqual([['node-a', 'c', 'l', 'u', 's1']]);
    expect(statements[0]).toContain('UPDATE sessions SET "nodeId"');
    expect(statements[0]).toContain('"claimedAt"');
    expect(statements[0]).toContain('"leaseExpiresAt"');
    expect(statements[0]).toContain('"nodeUrl"');
  });

  // The lease is a DEADLINE, and the transaction re-applying it can outlive what the deadline has
  // left. These three cases pin which way each kind of claim moves.
  const bindLease = async (leaseExpiresAt: unknown, readAt: Date, now: Date): Promise<unknown> => {
    const bound: unknown[][] = [];
    await restoreSessionOwnership(
      [{ id: 's1', nodeId: 'node-a', claimedAt: 'c', leaseExpiresAt, nodeUrl: 'u' }],
      (_sql, params) => {
        bound.push(params);
        return Promise.resolve();
      },
      readAt,
      now,
    );
    return bound[0][2];
  };

  it('carries a live claim by its remaining time, so a long import cannot expire it', async () => {
    const readAt = new Date('2026-08-06T10:00:00.000Z');
    const commitAt = new Date('2026-08-06T10:02:00.000Z'); // a two-minute restore
    // 30s left when read → 30s left when written, not an expiry two minutes in the past.
    expect(await bindLease('2026-08-06T10:00:30.000Z', readAt, commitAt)).toBe('2026-08-06T10:02:30.000Z');
  });

  it('leaves an already-lapsed claim exactly where it was, so a dead node stays dead', async () => {
    const readAt = new Date('2026-08-06T10:00:00.000Z');
    const commitAt = new Date('2026-08-06T10:02:00.000Z');
    // Shifting this one would resurrect a crashed peer's hold on the session.
    expect(await bindLease('2026-08-06T09:59:00.000Z', readAt, commitAt)).toBe('2026-08-06T09:59:00.000Z');
  });

  it('refuses to carry text that is not the UTC form the writers emit', async () => {
    const readAt = new Date('2026-08-06T10:00:00.000Z');
    const commitAt = new Date('2026-08-06T10:02:00.000Z');
    // `DateTransformer.to` and `leaseParam` both emit toISOString(), so a space-separated stamp can
    // only come from somewhere that does not know this contract — e.g. a future migration DEFAULT of
    // datetime('now'), the shape other columns in this repo already use. new Date() would read it as
    // LOCAL time, and carrying it would write the host's UTC offset back into the column for good.
    //
    // Two days ahead, not seconds: parsed as local time this lands within ±14h of that instant, so it
    // stays in the FUTURE under every timezone and would therefore be carried if the guard were gone.
    // A near stamp would fall through to the already-lapsed branch on a positive-offset host and pass
    // for the wrong reason — which is exactly what it did before this comment existed.
    expect(await bindLease('2026-08-08 10:00:00', readAt, commitAt)).toBe('2026-08-08 10:00:00');
  });

  it('never carries a lease to an earlier instant than the one it read', async () => {
    // A backward clock step between the read and the write-back. Without the clamp the carry would
    // land before the original deadline — re-creating the expired-on-commit state it exists to avoid.
    const readAt = new Date('2026-08-06T10:00:00.000Z');
    const steppedBack = new Date('2026-08-06T09:58:00.000Z');
    expect(await bindLease('2026-08-06T10:00:30.000Z', readAt, steppedBack)).toBe('2026-08-06T10:00:30.000Z');
  });

  it('falls back to the original value when the carry would overflow the Date range', async () => {
    // A throw here would reach the caller's catch, which records a warning — and every claim after
    // this row in the loop would silently never be re-applied.
    const readAt = new Date('2026-08-06T10:00:00.000Z');
    const commitAt = new Date('2026-08-06T10:02:00.000Z');
    const nearMax = '+275760-09-13T00:00:00.000Z'; // the maximum representable Date
    await expect(bindLease(nearMax, readAt, commitAt)).resolves.toBe(nearMax);
  });

  it('preserves the stored shape — Date in, Date out (Postgres); text in, text out (SQLite)', async () => {
    const readAt = new Date('2026-08-06T10:00:00.000Z');
    const commitAt = new Date('2026-08-06T10:02:00.000Z');
    const asDate = await bindLease(new Date('2026-08-06T10:00:30.000Z'), readAt, commitAt);
    expect(asDate).toBeInstanceOf(Date);
    expect((asDate as Date).toISOString()).toBe('2026-08-06T10:02:30.000Z');
    expect(typeof (await bindLease('2026-08-06T10:00:30.000Z', readAt, commitAt))).toBe('string');
    expect(await bindLease(null, readAt, commitAt)).toBeNull();
  });
});
