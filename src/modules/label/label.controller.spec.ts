import { NotImplementedException } from '@nestjs/common';
import { LabelController } from './label.controller';
import type { LabelService } from './label.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { ApiKey } from '../auth/entities/api-key.entity';

describe('LabelController - GET :labelId/chats for a chat-restricted key', () => {
  const getChatsByLabel = jest.fn();
  const controller = new LabelController({ getChatsByLabel } as unknown as LabelService, new ChatScopeService());
  const chats = [{ id: '999@g.us' }, { id: '123@g.us' }, { id: '62811@c.us' }];

  beforeEach(() => getChatsByLabel.mockReset());

  it('returns only the chats inside the key allowlist', async () => {
    getChatsByLabel.mockResolvedValue(chats);
    const out = await controller.getChatsByLabel('s1', 'l1', { allowedChats: ['123@g.us'] } as ApiKey);
    expect(getChatsByLabel).toHaveBeenCalledWith('s1', 'l1');
    expect(out).toEqual([{ id: '123@g.us' }]);
  });

  it('passes every chat through for an unrestricted key', async () => {
    getChatsByLabel.mockResolvedValue(chats);
    await expect(controller.getChatsByLabel('s1', 'l1', { allowedChats: null } as ApiKey)).resolves.toEqual(chats);
  });

  it('lets an engine refusal through unchanged', async () => {
    getChatsByLabel.mockRejectedValue(new NotImplementedException('no label query'));
    await expect(controller.getChatsByLabel('s1', 'l1', { allowedChats: ['123@g.us'] } as ApiKey)).rejects.toThrow(
      NotImplementedException,
    );
  });
});
