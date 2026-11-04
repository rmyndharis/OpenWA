import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

const key = (overrides: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 'key-1',
    role: ApiKeyRole.OPERATOR,
    lastUsedAt: new Date(),
    usageCount: 0,
    ...overrides,
  }) as ApiKey;

/**
 * A repository that only counts what reaches the database: `increment` can be held open, and the
 * windowed `update` is read back from its `"usageCount" + N` expression.
 */
function makeRepository() {
  const written: number[] = [];
  let gate: Promise<void> = Promise.resolve();
  let failNext = false;
  const repository = {
    increment: jest.fn(async (_criteria: unknown, _column: string, delta: number) => {
      await gate;
      if (failNext) {
        failNext = false;
        throw new Error('database write failed');
      }
      written.push(delta);
    }),
    update: jest.fn((_criteria: unknown, patch: { usageCount: () => string }) => {
      written.push(Number(/\+ (\d+)$/.exec(patch.usageCount())?.[1]));
      return Promise.resolve();
    }),
  };
  return {
    repository,
    total: () => written.reduce((sum, delta) => sum + delta, 0),
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>(resolve => (release = resolve));
      return release;
    },
    failNextIncrement: () => {
      failNext = true;
    },
  };
}

describe('ApiKeyUsageTracker shutdown flush', () => {
  it('keeps a use recorded while the flush awaits its write', async () => {
    const db = makeRepository();
    const tracker = new ApiKeyUsageTracker(db.repository as never);
    await tracker.record(key());
    await tracker.record(key());

    const release = db.hold();
    const flush = tracker.flushOnShutdown();
    await tracker.record(key());
    release();
    await flush;
    await tracker.flushOnShutdown();

    expect(db.total()).toBe(3);
  });

  it('does not write a use twice when the window closes while the flush awaits', async () => {
    const db = makeRepository();
    const tracker = new ApiKeyUsageTracker(db.repository as never);
    await tracker.record(key());
    await tracker.record(key());

    const release = db.hold();
    const flush = tracker.flushOnShutdown();
    await tracker.record(key({ lastUsedAt: new Date(Date.now() - 120_000) }));
    release();
    await flush;
    await tracker.flushOnShutdown();

    expect(db.total()).toBe(3);
  });

  it('keeps the failed batch and a use recorded meanwhile for the next flush', async () => {
    const db = makeRepository();
    const tracker = new ApiKeyUsageTracker(db.repository as never);
    await tracker.record(key());
    await tracker.record(key());

    const release = db.hold();
    db.failNextIncrement();
    const flush = tracker.flushOnShutdown();
    await tracker.record(key());
    release();
    await flush;
    await tracker.flushOnShutdown();

    expect(db.total()).toBe(3);
  });

  it('writes a batch once when two shutdown flushes overlap', async () => {
    const db = makeRepository();
    const tracker = new ApiKeyUsageTracker(db.repository as never);
    await tracker.record(key());
    await tracker.record(key());

    const release = db.hold();
    const first = tracker.flushOnShutdown();
    const second = tracker.flushOnShutdown();
    release();
    await Promise.all([first, second]);

    expect(db.total()).toBe(2);
    expect(db.repository.increment).toHaveBeenCalledTimes(1);
  });

  it('keeps a later key use while an earlier key of the batch awaits its write', async () => {
    const db = makeRepository();
    const tracker = new ApiKeyUsageTracker(db.repository as never);
    await tracker.record(key({ id: 'first' }));
    await tracker.record(key({ id: 'second' }));

    const release = db.hold();
    const flush = tracker.flushOnShutdown();
    await tracker.record(key({ id: 'second' }));
    release();
    await flush;
    await tracker.flushOnShutdown();

    expect(db.total()).toBe(3);
  });
});
