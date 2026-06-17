import { In, Repository } from 'typeorm';
import { MessageTypeBackfillService } from './message-type-backfill.service';
import { Message } from './entities/message.entity';

describe('MessageTypeBackfillService', () => {
  const makeService = (update: jest.Mock) => {
    const repo = { update } as unknown as Repository<Message>;
    return new MessageTypeBackfillService(repo);
  };

  it('rewrites each legacy wwebjs token to the neutral MessageType on bootstrap', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    await makeService(update).onApplicationBootstrap();

    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledWith({ type: 'chat' }, { type: 'text' });
    expect(update).toHaveBeenCalledWith({ type: 'ptt' }, { type: 'voice' });
    // vcard + multi_vcard collapse to contact via an IN clause
    expect(update).toHaveBeenCalledWith({ type: In(['vcard', 'multi_vcard']) }, { type: 'contact' });
  });

  it('is a no-op-safe write (idempotent): affected:0 on already-neutral rows does not throw', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 0 });
    await expect(makeService(update).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('does not crash boot if the backfill query fails', async () => {
    const update = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(makeService(update).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
