import { invokeTool } from '../tool-invoker';
import { sessionTools } from './session.tools';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { SessionService } from '../../../modules/session/session.service';
import type { AuthService } from '../../../modules/auth/auth.service';

// Covers every sessionTools execute() handler via the real invokeTool path (auth → zod → handler).
// agent-tools.module.ts is pure Nest wiring, stays at 0% coverage, and is intentionally not a target.

function makeAuth(): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

function makeTools(svc: SessionService): Map<string, AnyToolDescriptor> {
  return new Map(sessionTools(svc).map(t => [t.name, t]));
}

async function run(tool: AnyToolDescriptor, input: unknown): Promise<unknown> {
  return invokeTool(tool, input, 'key', makeAuth() as unknown as AuthService);
}

describe('sessionTools', () => {
  it('SessionFindAll scopes by the key allowedSessions and maps entities to DTOs', async () => {
    const findAll = jest.fn().mockResolvedValue([{ id: 's1', name: 'main', status: 'ready' }]);
    const isActive = jest.fn().mockReturnValue(true);
    const out = (await run(makeTools({ findAll, isActive } as unknown as SessionService).get('SessionFindAll')!, {
      limit: 5,
    })) as Array<{ id: string; engineLoaded: boolean }>;
    expect(findAll).toHaveBeenCalledWith(null, { limit: 5, offset: undefined });
    expect(isActive).toHaveBeenCalledWith('s1');
    expect(out).toEqual([expect.objectContaining({ id: 's1', engineLoaded: true })]);
  });

  it('SessionFindOne delegates to findOne and maps to the response DTO', async () => {
    const findOne = jest.fn().mockResolvedValue({ id: 's1', name: 'main', status: 'ready' });
    const isActive = jest.fn().mockReturnValue(false);
    const out = (await run(makeTools({ findOne, isActive } as unknown as SessionService).get('SessionFindOne')!, {
      sessionId: 's1',
    })) as { id: string; engineLoaded: boolean };
    expect(findOne).toHaveBeenCalledWith('s1');
    expect(out.id).toBe('s1');
    expect(out.engineLoaded).toBe(false);
  });

  it('SessionGetChats delegates to getChats with paging', async () => {
    const getChats = jest.fn().mockResolvedValue([{ id: 'c1' }]);
    const out = await run(makeTools({ getChats } as unknown as SessionService).get('SessionGetChats')!, {
      sessionId: 's1',
      limit: 20,
      offset: 10,
    });
    expect(getChats).toHaveBeenCalledWith('s1', { limit: 20, offset: 10 });
    expect(out).toEqual([{ id: 'c1' }]);
  });

  it('SessionGetStats scopes by the key allowedSessions', async () => {
    const stats = { total: 2, active: 1, ready: 1, disconnected: 1 };
    const getStats = jest.fn().mockResolvedValue(stats);
    const out = await run(makeTools({ getStats } as unknown as SessionService).get('SessionGetStats')!, {});
    expect(getStats).toHaveBeenCalledWith(null);
    expect(out).toEqual(stats);
  });

  it('SessionSubscribePresence delegates to subscribeToPresence and reports success', async () => {
    const subscribeToPresence = jest.fn().mockResolvedValue(undefined);
    const out = await run(
      makeTools({ subscribeToPresence } as unknown as SessionService).get('SessionSubscribePresence')!,
      { sessionId: 's1', chatId: '628111@c.us' },
    );
    expect(subscribeToPresence).toHaveBeenCalledWith('s1', '628111@c.us');
    expect(out).toEqual({ success: true });
  });

  it('SessionGetPresence delegates to getPresence and passes the result through', async () => {
    const getPresence = jest.fn().mockResolvedValue({ presence: 'online' });
    const out = await run(makeTools({ getPresence } as unknown as SessionService).get('SessionGetPresence')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
    });
    expect(getPresence).toHaveBeenCalledWith('s1', '628111@c.us');
    expect(out).toEqual({ presence: 'online' });
  });

  it('SessionMarkChatRead maps the sendSeen result to a success field', async () => {
    const sendSeen = jest.fn().mockResolvedValue(true);
    const out = await run(makeTools({ sendSeen } as unknown as SessionService).get('SessionMarkChatRead')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
    });
    expect(sendSeen).toHaveBeenCalledWith('s1', '628111@c.us');
    expect(out).toEqual({ success: true });
  });

  it('SessionMarkChatUnread maps the markUnread result to a success field', async () => {
    const markUnread = jest.fn().mockResolvedValue(true);
    const out = await run(makeTools({ markUnread } as unknown as SessionService).get('SessionMarkChatUnread')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
    });
    expect(markUnread).toHaveBeenCalledWith('s1', '628111@c.us');
    expect(out).toEqual({ success: true });
  });

  it('SessionSendChatState delegates to sendChatState and reports success', async () => {
    const sendChatState = jest.fn().mockResolvedValue(undefined);
    const out = await run(makeTools({ sendChatState } as unknown as SessionService).get('SessionSendChatState')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      state: 'typing',
    });
    expect(sendChatState).toHaveBeenCalledWith('s1', '628111@c.us', 'typing');
    expect(out).toEqual({ success: true });
  });
});
