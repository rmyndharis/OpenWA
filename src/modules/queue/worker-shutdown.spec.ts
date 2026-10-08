import { readFileSync } from 'fs';
import { join } from 'path';
import { Global, Module } from '@nestjs/common';
import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { BullModule } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue, Worker } from 'bullmq';
import { IngressProcessor } from './processors/ingress.processor';
import { WebhookProcessor } from './processors/webhook.processor';
import { QUEUE_NAMES } from './queue-names';
import { QueueModule } from './queue.module';
import { MAX_WORKER_CLOSE_WAIT_MS } from './processors/close-worker';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { HookManager } from '../../core/hooks';
import { DEFAULT_SHUTDOWN_DELAY_MS } from '../../common/services/shutdown.service';
import configuration from '../../config/configuration';
import { ApiKeyUsageTracker } from '../auth/api-key-usage-tracker.service';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';

/**
 * A worker that is still open when PluginLoaderService disables the plugins keeps taking jobs, and
 * each one fails against a terminated sandbox. The real lifecycle runs here (BullModule's explorer,
 * Nest's destroy and shutdown order, the real processors) with Redis-free queue and worker classes,
 * and the plugin stub sits in a global module the way PluginsModule does, so it is destroyed last.
 */
class FakeWorker {
  static all: FakeWorker[] = [];
  // Worker.close() while Redis is unreachable: it never settles.
  static closeHangs = false;
  closed = false;
  constructor(readonly name: string) {
    FakeWorker.all.push(this);
  }
  on(): this {
    return this;
  }
  close(): Promise<void> {
    if (FakeWorker.closeHangs) return new Promise(() => undefined);
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeQueue {
  constructor(
    readonly name: string,
    readonly opts: object = {},
  ) {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let pluginTeardownRan = false;

function buildRootModule(openAtPluginTeardown: string[]) {
  class PluginLoaderStub {
    onModuleDestroy(): void {
      pluginTeardownRan = true;
      openAtPluginTeardown.push(...FakeWorker.all.filter(w => !w.closed).map(w => w.name));
    }
  }
  @Global()
  @Module({
    providers: [{ provide: PluginLoaderService, useClass: PluginLoaderStub }],
    exports: [PluginLoaderService],
  })
  class PluginsStubModule {}

  const repo = {};
  @Module({
    imports: [
      BullModule.forRoot({ connection: {} }),
      BullModule.registerQueue({ name: QUEUE_NAMES.WEBHOOK }, { name: QUEUE_NAMES.INGRESS }),
    ],
    providers: [
      IngressProcessor,
      WebhookProcessor,
      { provide: getRepositoryToken(IntegrationDeliveryFailure, 'data'), useValue: repo },
      { provide: getRepositoryToken(IngressEvent, 'data'), useValue: repo },
      { provide: getRepositoryToken(Webhook, 'data'), useValue: repo },
      { provide: getRepositoryToken(WebhookDeliveryFailure, 'data'), useValue: repo },
      { provide: HookManager, useValue: {} },
      { provide: ConfigService, useValue: { get: (_key: string, fallback?: unknown) => fallback } },
      { provide: WebhookOutboxService, useValue: {} },
    ],
  })
  class QueueStubModule {}

  @Module({ imports: [PluginsStubModule, QueueStubModule] })
  class RootModule {}
  return RootModule;
}

describe('queue workers at shutdown', () => {
  beforeEach(() => {
    BullModule.queueClass = FakeQueue;
    BullModule.workerClass = FakeWorker;
    FakeWorker.all = [];
    FakeWorker.closeHangs = false;
    pluginTeardownRan = false;
  });

  afterAll(() => {
    BullModule.queueClass = Queue;
    BullModule.workerClass = Worker;
  });

  // Nest destroys global modules last; the ordering below only holds while QueueModule is not one of them.
  it('keeps the processors in a module that is not global', () => {
    expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, QueueModule)).toBeUndefined();
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, QueueModule)).toEqual(
      expect.arrayContaining([IngressProcessor, WebhookProcessor]),
    );
  });

  it('closes every worker before the plugins are torn down', async () => {
    const openAtPluginTeardown: string[] = [];
    const app = await NestFactory.createApplicationContext(buildRootModule(openAtPluginTeardown), { logger: false });
    expect(FakeWorker.all.map(w => w.name).sort()).toEqual([QUEUE_NAMES.INGRESS, QUEUE_NAMES.WEBHOOK].sort());

    await app.close();

    expect(openAtPluginTeardown).toEqual([]);
  });

  // The early close must not leave the plugins up forever when Redis is gone: past the bounded wait the
  // global destroy hooks run, as they did when the workers were only closed at application shutdown.
  it('stops waiting for a worker that cannot close and still tears down the plugins', async () => {
    FakeWorker.closeHangs = true;
    const app = await NestFactory.createApplicationContext(buildRootModule([]), { logger: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      void app.close();
      await jest.advanceTimersByTimeAsync(MAX_WORKER_CLOSE_WAIT_MS - 1);
      expect(pluginTeardownRan).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(pluginTeardownRan).toBe(true);
      const warned = warn.mock.calls.flat().join('\n');
      expect(warned).toContain(QUEUE_NAMES.INGRESS);
      expect(warned).toContain(QUEUE_NAMES.WEBHOOK);
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
  });

  // The global destroy hooks run after the capped wait, so the cap must leave them room inside the
  // shipped kill deadline after what shutdown spends before QueueModule is destroyed: SHUTDOWN_DELAY_MS,
  // the per-engine destroy deadline (engines torn down in parallel) and WEBHOOK_SHUTDOWN_DRAIN_MS; then
  // the bounded API-key usage flush. The defaults come from their sources, so raising one fails here.
  it('leaves the global destroy hooks room inside the shipped kill deadline', () => {
    const root = join(__dirname, '../../..');
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const values = readFileSync(join(root, 'charts/openwa/values.yaml'), 'utf8');
    const graceMs = [
      Number(/^\s+stop_grace_period: (\d+)s$/m.exec(compose)?.[1]) * 1000,
      Number(/^terminationGracePeriodSeconds: (\d+)$/m.exec(values)?.[1]) * 1000,
    ];

    // Hard-coded: an inline literal in SessionLifecycleFences.teardownEngineSafely, not exported.
    const engineTeardown = 10_000;
    const beforeQueueClose = DEFAULT_SHUTDOWN_DELAY_MS + engineTeardown + configuration().webhook.shutdownDrainMs;
    const usageFlush = ApiKeyUsageTracker.SHUTDOWN_FLUSH_TIMEOUT_MS;
    expect(beforeQueueClose + MAX_WORKER_CLOSE_WAIT_MS + usageFlush).toBeLessThan(Math.min(...graceMs));
  });

  // A bootstrap that fails before listen() closes an app whose workers were never created; the destroy
  // hooks must not reject, or the remaining teardown (plugins, database, Redis) is skipped.
  it('tears down an app closed before its workers were created', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [buildRootModule([])] }).compile();
    expect(FakeWorker.all).toEqual([]);

    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(pluginTeardownRan).toBe(true);
  });
});
