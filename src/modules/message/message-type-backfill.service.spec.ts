import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MessageTypeBackfillService } from './message-type-backfill.service';
import { Message } from './entities/message.entity';

describe('MessageTypeBackfillService', () => {
  const makeService = (
    opts: { synchronize?: boolean; query?: jest.Mock<Promise<void>, [string]>; hasTable?: boolean } = {},
  ) => {
    const query = opts.query ?? jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
    const runner = {
      hasTable: jest.fn().mockResolvedValue(opts.hasTable ?? true),
      query,
      release: jest.fn().mockResolvedValue(undefined),
    };
    const repo = { manager: { connection: { createQueryRunner: () => runner } } } as unknown as Repository<Message>;
    const config = {
      get: (key: string, fallback: unknown) => (key === 'dataDatabase.synchronize' ? opts.synchronize : fallback),
    } as unknown as ConfigService;
    return { service: new MessageTypeBackfillService(repo, config), runner, query };
  };

  it('converts the legacy wwebjs tokens with one statement under DATABASE_SYNCHRONIZE=true', async () => {
    const { service, runner, query } = makeService({ synchronize: true });
    await service.onApplicationBootstrap();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain(`WHEN 'chat' THEN 'text'`);
    expect(sql).toContain(`WHEN 'ptt' THEN 'voice'`);
    expect(sql).toContain(`WHEN 'multi_vcard' THEN 'contact'`);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])(
    'leaves a migration-managed database to the migration (synchronize: %s)',
    async synchronize => {
      const { service, runner, query } = makeService({ synchronize });
      await service.onApplicationBootstrap();

      expect(query).not.toHaveBeenCalled();
      expect(runner.release).not.toHaveBeenCalled();
    },
  );

  it('does nothing when the config is not injected', async () => {
    const query = jest.fn();
    const repo = {
      manager: { connection: { createQueryRunner: () => ({ query }) } },
    } as unknown as Repository<Message>;

    await expect(new MessageTypeBackfillService(repo).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not crash boot if the backfill query fails, and still releases the runner', async () => {
    const { service, runner } = makeService({
      synchronize: true,
      query: jest.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
