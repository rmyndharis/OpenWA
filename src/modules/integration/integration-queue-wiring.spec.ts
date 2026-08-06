/**
 * Wiring coverage for the QUEUE_ENABLED-conditional QueueModule import in integration.module.ts.
 *
 * Background: @nestjs/bullmq registers queue providers (token `BullQueue_<name>`) as MODULE-scoped —
 * a queue is only injectable into providers of a module that imports the module which registered it.
 * app.module.ts and webhook.module.ts already import QueueModule conditionally, but that does NOT
 * make the ingress queue visible inside IntegrationModule: without its own conditional import,
 * IngressEnqueueService's @Optional() @InjectQueue(QUEUE_NAMES.INGRESS) silently resolves to
 * undefined and every ingress delivery dispatches inline even with QUEUE_ENABLED=true (no fast-ack
 * deferral, no retries, no ordering, empty Bull Board) with zero signal. These tests compile the
 * REAL module graph and assert the queue actually reaches IngressEnqueueService.
 *
 * process.env.QUEUE_ENABLED is read at MODULE-EVAL time (the lazy-require conditional pattern shared
 * with webhook.module.ts), so each test sets it BEFORE require()-ing the graph and runs in a fresh
 * module registry (jest.resetModules()). Nothing from the app may be imported statically at the top
 * of this file, and every class token inside one test must come from the same registry generation —
 * DI compares classes by identity, so mixing generations silently breaks injection.
 *
 * bullmq's Queue opens an ioredis connection in its constructor and re-emits connection failures as
 * 'error' events, which would crash a Redis-less unit run. The wiring under test (module graph,
 * provider tokens, injection) lives entirely in @nestjs/common / @nestjs/bullmq, so only the Redis
 * client classes are stubbed; every assertion below exercises the real DI machinery.
 */
jest.mock('bullmq', () => {
  const actual = jest.requireActual<Record<string, unknown>>('bullmq');
  class StubQueue {
    readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = jest.fn().mockResolvedValue(undefined);
    close = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn().mockResolvedValue(undefined);
  }
  class StubWorker {
    close = jest.fn().mockResolvedValue(undefined);
  }
  return { ...actual, Queue: StubQueue, Worker: StubWorker };
});

import type { DynamicModule } from '@nestjs/common';

/** Minimal shape of the stubbed BullMQ queue the assertions need. */
interface QueueLike {
  name: string;
  add: jest.Mock;
}

describe('IntegrationModule queue wiring (QUEUE_ENABLED conditional)', () => {
  const ORIGINAL = process.env.QUEUE_ENABLED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.QUEUE_ENABLED;
    else process.env.QUEUE_ENABLED = ORIGINAL;
    jest.resetModules();
  });

  async function compileIntegrationModule(queueEnabled: 'true' | 'false') {
    process.env.QUEUE_ENABLED = queueEnabled;
    jest.resetModules();

    // require() (not static import) so the module-eval QUEUE_ENABLED conditional sees the value set
    // above; `as typeof import(...)` is type-only and keeps the typed-lint rules satisfied.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
    const { ConfigModule } = require('@nestjs/config') as typeof import('@nestjs/config');
    const { ThrottlerModule } = require('@nestjs/throttler') as typeof import('@nestjs/throttler');
    const { getDataSourceToken } = require('@nestjs/typeorm') as typeof import('@nestjs/typeorm');
    const { getQueueToken } = require('@nestjs/bullmq') as typeof import('@nestjs/bullmq');
    const configuration = (require('../../config/configuration') as typeof import('../../config/configuration'))
      .default;
    const { IntegrationModule } = require('./integration.module') as typeof import('./integration.module');
    const { IngressEnqueueService } =
      require('./ingress-enqueue.service') as typeof import('./ingress-enqueue.service');
    const { HooksModule } = require('../../core/hooks/hooks.module') as typeof import('../../core/hooks/hooks.module');
    const { PluginsModule } =
      require('../../core/plugins/plugins.module') as typeof import('../../core/plugins/plugins.module');
    const { AuditService } = require('../audit/audit.service') as typeof import('../audit/audit.service');
    const { EventsGateway } = require('../events/events.gateway') as typeof import('../events/events.gateway');
    const { QueueModule } = require('../queue/queue.module') as typeof import('../queue/queue.module');
    const { QUEUE_NAMES } = require('../queue/queue-names') as typeof import('../queue/queue-names');
    /* eslint-enable @typescript-eslint/no-require-imports */

    // The @Global modules app.module.ts imports once (AuditModule/EventsModule), stubbed so this spec
    // compiles IntegrationModule's real graph without booting HTTP/WS/DB. The 'data' DataSource stub
    // feeds every TypeOrmModule.forFeature repository factory (entityMetadatas:[] → not a tree entity,
    // type!=='mongodb' → plain getRepository).
    const dataSourceStub = {
      entityMetadatas: [],
      options: { type: 'sqlite' },
      getRepository: () => ({}),
    };
    const testGlobals: DynamicModule = {
      module: class TestGlobalsModule {},
      global: true,
      providers: [
        { provide: getDataSourceToken('data'), useValue: dataSourceStub },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: EventsGateway, useValue: {} },
      ],
      exports: [getDataSourceToken('data'), AuditService, EventsGateway],
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [configuration] }),
        // InstanceThrottlerGuard (@UseGuards on the ingress controller) is container-instantiated at
        // compile time; it needs the throttler options/storage app.module.ts normally provides.
        ThrottlerModule.forRoot([{ name: 'instance', ttl: 60_000, limit: 120 }]),
        HooksModule,
        PluginsModule,
        testGlobals,
        IntegrationModule,
      ],
    }).compile();

    return { moduleRef, getQueueToken, QUEUE_NAMES, QueueModule, IntegrationModule, IngressEnqueueService };
  }

  it('QUEUE_ENABLED=true: IntegrationModule imports QueueModule (module metadata)', async () => {
    const { moduleRef, IntegrationModule, QueueModule } = await compileIntegrationModule('true');
    try {
      // MODULE_METADATA.IMPORTS === 'imports'; read via Reflect to avoid another registry-sensitive import.
      const imports = Reflect.getMetadata('imports', IntegrationModule) as unknown[];
      expect(imports).toContain(QueueModule);
    } finally {
      await moduleRef.close();
    }
  });

  it('QUEUE_ENABLED=true: the ingress queue is INJECTED into IngressEnqueueService and enqueue() queues', async () => {
    const { moduleRef, getQueueToken, QUEUE_NAMES, IngressEnqueueService } = await compileIntegrationModule('true');
    try {
      const queue = moduleRef.get<QueueLike>(getQueueToken(QUEUE_NAMES.INGRESS), { strict: false });
      expect(queue).toBeDefined();
      expect(queue.name).toBe(QUEUE_NAMES.INGRESS);

      // The decisive assertion. moduleRef.get(token, {strict:false}) alone would ALSO pass pre-fix —
      // webhook.module.ts imports QueueModule for its own scope, so the queue provider exists in the
      // container either way. What was broken is the injection INTO IntegrationModule's provider; the
      // tripwire reads that injected field, so it only stays silent when the wiring genuinely reached
      // IntegrationModule (pre-fix it throws here even though the token resolves above).
      const enqueue = moduleRef.get(IngressEnqueueService, { strict: false });
      expect(() => enqueue.onApplicationBootstrap()).not.toThrow();

      // ...and the full queued-dispatch contract holds: enqueue() hands the job to BullMQ (with the
      // deliveryId as jobId) instead of falling back to inline dispatch.
      const outcome = await enqueue.enqueue(
        {
          pluginId: 'chatwoot',
          instanceId: 'acct1',
          route: 'chatwoot',
          deliveryId: 'd1',
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        },
        'd1',
      );
      expect(outcome).toEqual({ outcome: 'queued' });
      expect(queue.add).toHaveBeenCalledWith(
        'ingress',
        expect.objectContaining({ deliveryId: 'd1' }),
        expect.objectContaining({ jobId: 'd1' }),
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('QUEUE_ENABLED=false: the module boots queue-free (no queue import, no token, silent tripwire)', async () => {
    const { moduleRef, getQueueToken, QUEUE_NAMES, IntegrationModule, QueueModule, IngressEnqueueService } =
      await compileIntegrationModule('false');
    try {
      const imports = Reflect.getMetadata('imports', IntegrationModule) as unknown[];
      expect(imports).not.toContain(QueueModule);
      expect(() => moduleRef.get<QueueLike>(getQueueToken(QUEUE_NAMES.INGRESS), { strict: false })).toThrow();

      const enqueue = moduleRef.get(IngressEnqueueService, { strict: false });
      expect(enqueue).toBeDefined();
      expect(() => enqueue.onApplicationBootstrap()).not.toThrow();
    } finally {
      await moduleRef.close();
    }
  });
});
