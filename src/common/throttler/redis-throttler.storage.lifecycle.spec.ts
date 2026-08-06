import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import type { Redis } from 'ioredis';

describe('RedisThrottlerStorage lifecycle wiring', () => {
  it('Nest invokes onModuleDestroy on the storage instance registered via a factory provider', async () => {
    const redis = {
      eval: jest.fn(),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);

    // Mirror @nestjs/throttler's ThrottlerStorageProvider: a useFactory returning options.storage.
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: 'THROTTLER_OPTIONS', useValue: { storage } },
        {
          provide: ThrottlerStorage,
          useFactory: (options: { storage: RedisThrottlerStorage }) => options.storage,
          inject: ['THROTTLER_OPTIONS'],
        },
      ],
    }).compile();

    await moduleRef.close();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
