import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';

const base = {
  webhookId: 'wh-1',
  sessionId: 'sess-1',
  event: 'message.received',
  idempotencyKey: 'key_wh-1',
  deliveryId: 'del-1',
  payload: { from: '628123456789@c.us' },
};

describe('WebhookOutboxService', () => {
  let repo: { save: jest.Mock; create: jest.Mock; update: jest.Mock; find: jest.Mock };
  let service: WebhookOutboxService;

  beforeEach(() => {
    repo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    service = new WebhookOutboxService(repo as never);
  });

  it('records the delivery as pending, carrying the payload a replay needs', async () => {
    await service.open(base);

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ ...base, state: 'pending', attempts: 0 }));
  });

  it('treats a duplicate as the replay it is, keeping the existing row', async () => {
    const conflict = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    repo.save.mockRejectedValue(conflict);

    // A conflict on (webhookId, idempotencyKey) means this delivery is already recorded. Throwing
    // would surface as an unhandled rejection on a fire-and-forget path.
    await expect(service.open(base)).resolves.toBeUndefined();
  });

  it('never lets a repository failure reach a fire-and-forget caller', async () => {
    repo.save.mockRejectedValue(new Error('disk full'));
    await expect(service.open(base)).resolves.toBeUndefined();

    repo.update.mockRejectedValue(new Error('disk full'));
    await expect(service.close('wh-1', 'key_wh-1', 'dispatched')).resolves.toBeUndefined();
    // A failed increment resolves false — the caller must not claim a row it cannot count.
    await expect(service.countAttempt('row-1', 0)).resolves.toBe(false);
  });

  it('retires the payload when recording an outcome, so a settled row stops carrying a message body', async () => {
    await service.close('wh-1', 'key_wh-1', 'dispatched');

    expect(repo.update).toHaveBeenCalledWith(
      { webhookId: 'wh-1', idempotencyKey: 'key_wh-1' },
      expect.objectContaining({ state: 'dispatched', payload: null }),
    );
  });

  it('returns only rows that still carry a payload: a retired row is not replayable', async () => {
    const row = (over: Partial<WebhookOutboxEvent>): WebhookOutboxEvent => ({
      id: 'r',
      ...base,
      attempts: 0,
      state: 'pending',
      lastAttemptAt: null,
      createdAt: new Date(),
      ...over,
    });
    repo.find.mockResolvedValue([row({ id: 'keep' }), row({ id: 'retired', payload: null })]);

    const stale = await service.findStale(new Date(), 50);

    expect(stale.map(r => r.id)).toEqual(['keep']);
  });

  it('counts an attempt by incrementing the observed number — which doubles as the row claim', async () => {
    await service.countAttempt('row-1', 2);

    // The observed count rides in the WHERE: when two nodes sweep the same row, only the one whose
    // observation still matches wins the increment; the loser is told so and skips the replay.
    expect(repo.update).toHaveBeenCalledWith({ id: 'row-1', attempts: 2 }, expect.objectContaining({ attempts: 3 }));
  });

  it('reports a lost claim: an increment that matched no row resolves false', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    await expect(service.countAttempt('row-1', 2)).resolves.toBe(false);
  });
});

describe('WebhookOutboxService retention', () => {
  let repo: { delete: jest.Mock };
  let service: WebhookOutboxService;

  beforeEach(() => {
    repo = { delete: jest.fn().mockResolvedValue({ affected: 3 }) };
    service = new WebhookOutboxService(repo as never);
  });

  it('prunes settled rows only, never one that can still be replayed', async () => {
    const removed = await service.pruneSettled(7);

    expect(removed).toBe(3);
    const [[where]] = repo.delete.mock.calls as unknown as [
      [{ state: { type: string; value: unknown }; createdAt: { type: string } }],
    ];
    // Deleting a 'pending' row on age would discard the delivery this table exists to protect.
    expect(where.state.type).toBe('not');
    expect(where.state.value).toBe('pending');
    expect(where.createdAt.type).toBe('lessThan');
  });

  it('refuses a retention window that would let the table grow without bound', () => {
    const prev = process.env.WEBHOOK_OUTBOX_RETENTION_DAYS;
    process.env.WEBHOOK_OUTBOX_RETENTION_DAYS = '0';
    try {
      service.onModuleInit();
      // A settled row carries no payload and no audit value, so opting into unbounded growth buys
      // nothing: the value falls back rather than disabling the prune.
      expect(repo.delete).toHaveBeenCalled();
    } finally {
      service.onModuleDestroy();
      if (prev === undefined) delete process.env.WEBHOOK_OUTBOX_RETENTION_DAYS;
      else process.env.WEBHOOK_OUTBOX_RETENTION_DAYS = prev;
    }
  });
});
