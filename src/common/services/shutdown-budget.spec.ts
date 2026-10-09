import { readFileSync } from 'fs';
import { join } from 'path';
import { CACHE_QUIT_TIMEOUT_MS } from '../cache/cache.service';
import { THROTTLER_REDIS_QUIT_TIMEOUT_MS } from '../throttler/redis-throttler.storage';
import configuration from '../../config/configuration';
import { PLUGIN_SHUTDOWN_WAIT_MS } from '../../core/plugins/plugin-loader.service';
import { ApiKeyUsageTracker } from '../../modules/auth/api-key-usage-tracker.service';
import { WS_REDIS_QUIT_TIMEOUT_MS } from '../../modules/events/redis-io.adapter';
import { INGRESS_DISPATCH_TIMEOUT_MS } from '../../modules/integration/integration.constants';
import { MAX_WORKER_CLOSE_WAIT_MS } from '../../modules/queue/processors/close-worker';
import { QUEUE_NAMES } from '../../modules/queue/queue-names';
import { QUEUE_CLOSE_TIMEOUT_MS } from '../../modules/queue/shutdown-safe-queue';
import { ENGINE_TEARDOWN_TIMEOUT_MS } from '../../modules/session/session-lifecycle-fences';
import { AUTOSTART_SHUTDOWN_WAIT_MS } from '../../modules/session/session.service';
import {
  DEFAULT_SHUTDOWN_DELAY_MS,
  DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS,
  SHUTDOWN_KILL_DEADLINE_MS,
  SHUTDOWN_TEARDOWN_LIMIT_MS,
  shutdownTeardownLimitMs,
} from './shutdown-budget';

/**
 * The bounded teardown stages, summed in Nest destroy order, must fit the shipped kill deadline. The
 * figures come from the constants the stages use, so raising one without raising the deadline (and the
 * table in shutdown-budget.ts) fails here. A new bounded stage has to be added to the sums below.
 */
describe('shutdown time budget', () => {
  const MIN_RESERVE_MS = 5_000;
  const root = join(__dirname, '../../..');
  // Each queue is its own BullModule.registerQueue module, and Nest closes modules one after the other.
  const QUEUE_COUNT = Object.keys(QUEUE_NAMES).length;
  const base =
    DEFAULT_SHUTDOWN_DELAY_MS +
    INGRESS_DISPATCH_TIMEOUT_MS +
    ENGINE_TEARDOWN_TIMEOUT_MS +
    AUTOSTART_SHUTDOWN_WAIT_MS +
    DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS +
    ApiKeyUsageTracker.SHUTDOWN_FLUSH_TIMEOUT_MS;
  const withPlugins = base + PLUGIN_SHUTDOWN_WAIT_MS;
  const clustered =
    withPlugins +
    MAX_WORKER_CLOSE_WAIT_MS +
    QUEUE_CLOSE_TIMEOUT_MS * QUEUE_COUNT +
    THROTTLER_REDIS_QUIT_TIMEOUT_MS +
    CACHE_QUIT_TIMEOUT_MS +
    WS_REDIS_QUIT_TIMEOUT_MS;

  it('sums to the documented totals', () => {
    expect([base, withPlugins, clustered]).toEqual([33_000, 43_000, 63_000]);
  });

  it('registers one queue module per queue name, so the queue stage is counted per queue', () => {
    const source = readFileSync(join(root, 'src/modules/queue/queue.module.ts'), 'utf8');
    expect(source.match(/BullModule\.registerQueue(Async)?\(/g)).toHaveLength(QUEUE_COUNT);
  });

  it('uses the webhook drain default the budget is written for', () => {
    expect(configuration().webhook.shutdownDrainMs).toBe(DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
  });

  // The reserve pays for the uncapped hooks after the HTTP close. A stage added or raised eats into it; the
  // message names the fix, so the failure does not read as a bare number mismatch.
  it('leaves a reserve for the hooks after the HTTP close, even when every cap is hit at once', () => {
    const reserveMs = SHUTDOWN_TEARDOWN_LIMIT_MS - (clustered - DEFAULT_SHUTDOWN_DELAY_MS);
    expect(
      reserveMs >= MIN_RESERVE_MS
        ? 'ok'
        : `reserve ${reserveMs} ms < ${MIN_RESERVE_MS} ms: raise SHUTDOWN_KILL_DEADLINE_MS, both compose files and the chart in step`,
    ).toBe('ok');
  });

  it('keeps the 67 s teardown limit and the 5 s kill margin the docs quote', () => {
    expect(SHUTDOWN_TEARDOWN_LIMIT_MS).toBe(67_000);
    expect(SHUTDOWN_KILL_DEADLINE_MS - DEFAULT_SHUTDOWN_DELAY_MS - SHUTDOWN_TEARDOWN_LIMIT_MS).toBe(5_000);
  });

  // The prose that quotes the limit and the totals has to follow the constants.
  it.each([
    ['CHANGELOG.md', [SHUTDOWN_TEARDOWN_LIMIT_MS, SHUTDOWN_KILL_DEADLINE_MS]],
    ['.env.example', [SHUTDOWN_TEARDOWN_LIMIT_MS, SHUTDOWN_KILL_DEADLINE_MS]],
    ['docs/06-api-specification.md', [SHUTDOWN_TEARDOWN_LIMIT_MS]],
    ['docker-compose.yml', [SHUTDOWN_TEARDOWN_LIMIT_MS, base, clustered]],
    ['charts/openwa/values.yaml', [SHUTDOWN_TEARDOWN_LIMIT_MS, clustered]],
  ])('quotes the current figures in %s', (file, figures) => {
    const text = readFileSync(join(root, file), 'utf8');
    for (const ms of figures) expect(text).toMatch(new RegExp(`\\b${ms / 1000} ?s\\b`));
  });

  it('moves the teardown limit 1:1 with WEBHOOK_SHUTDOWN_DRAIN_MS and keeps it a valid timer delay', () => {
    expect(shutdownTeardownLimitMs(DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS)).toBe(SHUTDOWN_TEARDOWN_LIMIT_MS);
    expect(shutdownTeardownLimitMs(DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS + 7_000)).toBe(SHUTDOWN_TEARDOWN_LIMIT_MS + 7_000);
    expect(shutdownTeardownLimitMs(0)).toBe(SHUTDOWN_TEARDOWN_LIMIT_MS - DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
    expect(shutdownTeardownLimitMs(Number.MAX_SAFE_INTEGER)).toBe(2 ** 31 - 1);
  });

  it('matches the shipped kill deadlines in both compose files and the Helm chart', () => {
    const grace = (file: string) =>
      Number(/^\s+stop_grace_period: (\d+)s$/m.exec(readFileSync(join(root, file), 'utf8'))?.[1]) * 1000;
    const values = readFileSync(join(root, 'charts/openwa/values.yaml'), 'utf8');
    expect(grace('docker-compose.yml')).toBe(SHUTDOWN_KILL_DEADLINE_MS);
    expect(grace('docker-compose.dev.yml')).toBe(SHUTDOWN_KILL_DEADLINE_MS);
    expect(Number(/^terminationGracePeriodSeconds: (\d+)$/m.exec(values)?.[1]) * 1000).toBe(SHUTDOWN_KILL_DEADLINE_MS);
  });

  it('destroys open sockets at the HTTP close, which the table counts as 0 s', () => {
    expect(readFileSync(join(root, 'src/main.ts'), 'utf8')).toMatch(/^\s+forceCloseConnections: true,/m);
  });
});
