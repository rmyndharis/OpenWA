import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookReconcilerService, WebhookReconcilerOptions } from './webhook-reconciler.service';
import type { WebhookDeliveryService } from './webhook-delivery.service';
import type { Webhook } from './entities/webhook.entity';

const OPTS: WebhookReconcilerOptions = { intervalMs: 60_000, graceMs: 60_000, batchSize: 3, maxAttempts: 5 };
const MINUTE = 60_000;

// The sweep reads the stale rows page by page, after a cursor. A page that does not fill its batch has reached the
// end of them, so the next pass starts at the oldest row again: a row whose job was live when it was read and is lost
// since lies behind the cursor otherwise, and stays there for as long as newer stale rows keep arriving.
describe('WebhookReconcilerService: the walk over the stale rows', () => {
  let ds: DataSource;
  let repo: Repository<WebhookOutboxEvent>;
  let live: Set<string>;
  let replayed: string[];
  let reconciler: WebhookReconcilerService;
  let t0: number;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
    repo = ds.getRepository(WebhookOutboxEvent);
    live = new Set();
    replayed = [];
    const webhooks = {
      findOne: ({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          active: true,
          events: ['message.received'],
          sessionId: 'sess-1',
          url: 'https://receiver.example/hook',
        }),
    } as unknown as Repository<Webhook>;
    const delivery = {
      isLocallyPending: () => false,
      isQueueJobPending: (deliveryId: string) => Promise.resolve(live.has(deliveryId)),
      hasQueueJobCompleted: () => Promise.resolve(false),
      recordReplayExhaustion: () => Promise.resolve(true),
      redeliver: (_webhook: unknown, _session: string, _event: string, key: string) => {
        replayed.push(key);
        return Promise.resolve('queued');
      },
    } as unknown as WebhookDeliveryService;
    reconciler = new WebhookReconcilerService(webhooks, new WebhookOutboxService(repo), delivery, {
      get: () => undefined,
    } as unknown as ConfigService);
    t0 = Date.parse('2026-11-20T10:00:00.000Z');
  });

  afterEach(() => ds.destroy());

  const addRow = async (key: string, minutesAfterT0: number, hasLiveJob: boolean): Promise<void> => {
    const deliveryId = `dlv-${key}`;
    await repo.insert({
      webhookId: 'wh-1',
      sessionId: 'sess-1',
      event: 'message.received',
      idempotencyKey: key,
      deliveryId,
      payload: { event: 'message.received' },
      state: 'queued',
      attempts: 0,
      createdAt: new Date(t0 + minutesAfterT0 * MINUTE),
    });
    if (hasLiveJob) live.add(deliveryId);
  };
  const sweepAt = (minutesAfterT0: number) => reconciler.sweep(OPTS, new Date(t0 + minutesAfterT0 * MINUTE));

  it('replays a row whose job was lost, though a newer stale row with a live job turns up before every pass', async () => {
    await addRow('A', 0, true);
    await sweepAt(10); // A is stale and its job is live: looked at, left alone
    expect(replayed).toEqual([]);

    live.delete('dlv-A'); // the queue lost it (a restore from an earlier snapshot)
    for (let pass = 1; pass <= 3; pass++) {
      await addRow(`B${pass}`, pass, true); // a backlog behind a slow receiver: one newer stale row per pass
      await sweepAt(10 + pass);
    }

    expect(replayed).toContain('A');
  });

  it('goes on after a page that filled its batch, so a backlog longer than a page is walked to its end', async () => {
    for (const [index, key] of ['A', 'B', 'C', 'D', 'E'].entries()) await addRow(key, index, true);
    live.delete('dlv-E'); // the last row of the backlog lost its job

    await sweepAt(10); // A, B, C: a full page, live jobs
    expect(replayed).toEqual([]);
    await sweepAt(11); // D, E: the page behind the cursor

    expect(replayed).toEqual(['E']);
  });

  it('starts again at the oldest row once the walk has reached the end', async () => {
    for (const [index, key] of ['A', 'B', 'C', 'D'].entries()) await addRow(key, index, true);

    await sweepAt(10); // A, B, C
    await sweepAt(11); // D: a page that did not fill its batch
    live.delete('dlv-A');
    await sweepAt(12);

    expect(replayed).toEqual(['A']);
  });
});
