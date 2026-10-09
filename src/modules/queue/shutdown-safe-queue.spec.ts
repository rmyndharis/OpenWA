import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LoggerModule } from '../../common/services/logger.module';
import { LoggerService } from '../../common/services/logger.service';
import { QUEUE_CLOSE_TIMEOUT_MS, ShutdownSafeQueue } from './shutdown-safe-queue';

const REDIS_DOWN = "Stream isn't writeable and enableOfflineQueue options is false";

/** A ShutdownSafeQueue with no Redis behind it: Queue.close() rejects the way a dropped connection does. */
class DroppedQueue {
  constructor(readonly name: string) {
    return Object.assign(Object.create(ShutdownSafeQueue.prototype), { name }) as DroppedQueue;
  }
}

describe('ShutdownSafeQueue', () => {
  let superClose: jest.SpyInstance;
  let disconnect: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    superClose = jest.spyOn(Queue.prototype, 'close').mockRejectedValue(new Error(REDIS_DOWN));
    disconnect = jest.spyOn(Object.getPrototypeOf(Queue.prototype), 'disconnect').mockResolvedValue(undefined);
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => {
    BullModule.queueClass = Queue;
  });

  it('settles a close that rejects, logs it and drops the connection', async () => {
    const queue = new DroppedQueue('webhook') as unknown as ShutdownSafeQueue;

    await expect(queue.close()).resolves.toBeUndefined();

    expect(superClose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain(REDIS_DOWN);
  });

  // A half-open socket swallows the QUIT: the close neither resolves nor rejects.
  it('settles a close that never settles at the deadline, logs it and drops the connection', async () => {
    jest.useFakeTimers();
    try {
      superClose.mockReturnValue(new Promise(() => undefined));
      const queue = new DroppedQueue('webhook') as unknown as ShutdownSafeQueue;
      let settled = false;
      const closing = queue.close().then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(QUEUE_CLOSE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await closing;

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).toContain(`${QUEUE_CLOSE_TIMEOUT_MS} ms`);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves no timer behind after a close that resolves', async () => {
    jest.useFakeTimers();
    try {
      superClose.mockResolvedValue(undefined);
      const queue = new DroppedQueue('webhook') as unknown as ShutdownSafeQueue;
      await queue.close();

      expect(jest.getTimerCount()).toBe(0);
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not wait for a disconnect that never settles', async () => {
    disconnect.mockReturnValue(new Promise(() => undefined));
    const queue = new DroppedQueue('webhook') as unknown as ShutdownSafeQueue;

    await expect(queue.close()).resolves.toBeUndefined();
  });

  // Nest does not catch a rejected shutdown hook, so one queue that fails to close would skip the hooks
  // of every module destroyed after it. Global modules, the DataSource's among them, are destroyed last.
  it('lets the later shutdown hooks run when the producer close fails in a real app', async () => {
    BullModule.queueClass = DroppedQueue;
    let databaseClosed = false;

    @Global()
    @Module({})
    class DatabaseStubModule {
      onApplicationShutdown(): void {
        databaseClosed = true;
      }
    }
    @Module({
      imports: [
        LoggerModule,
        DatabaseStubModule,
        BullModule.forRoot({ connection: {} }),
        BullModule.registerQueue({ name: 'webhook' }),
      ],
    })
    class RootModule {}

    const app = await NestFactory.createApplicationContext(RootModule, { logger: false });
    await expect(app.close()).resolves.toBeUndefined();

    expect(superClose).toHaveBeenCalled();
    expect(databaseClosed).toBe(true);
  });
});
