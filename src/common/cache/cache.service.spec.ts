import { ConfigService } from '@nestjs/config';
import { CacheService, CACHE_QUIT_TIMEOUT_MS } from './cache.service';

describe('CacheService.onModuleDestroy (bounded shutdown)', () => {
  const makeService = (): CacheService => {
    const configService = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService;
    return new CacheService(configService);
  };
  const withRedis = (service: CacheService, redis: unknown): void => {
    (service as unknown as { redis: unknown }).redis = redis;
  };

  it('returns immediately when there is no redis client', async () => {
    await expect(makeService().onModuleDestroy()).resolves.toBeUndefined();
  });

  it('completes via a clean quit() without force-disconnecting', async () => {
    const service = makeService();
    const redis = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    withRedis(service, redis);

    await service.onModuleDestroy();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('force-disconnects when quit() hangs past the deadline (shutdown still completes)', async () => {
    jest.useFakeTimers();
    try {
      const service = makeService();
      const redis = { quit: jest.fn(() => new Promise<string>(() => {})), disconnect: jest.fn() }; // never resolves
      withRedis(service, redis);

      const done = service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(CACHE_QUIT_TIMEOUT_MS);
      await done;

      expect(redis.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
