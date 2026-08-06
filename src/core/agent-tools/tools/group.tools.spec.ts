import { invokeTool } from '../tool-invoker';
import { groupTools } from './group.tools';
import type { GroupService } from '../../../modules/group/group.service';
import type { AuthService } from '../../../modules/auth/auth.service';
import type { ParticipantOperationResult } from '../../../engine/interfaces/whatsapp-engine.interface';

function makeAuth(): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

describe('GroupAddParticipants', () => {
  it('returns the engine per-participant results instead of a blanket success', async () => {
    const results: ParticipantOperationResult[] = [
      { id: '628111@c.us', success: true, status: 200 },
      { id: '628222@c.us', success: false, status: 403, message: 'invite-only' },
    ];
    const addParticipants = jest.fn().mockResolvedValue(results);
    const groupSvc = { addParticipants } as unknown as GroupService;

    const tool = groupTools(groupSvc).find(t => t.name === 'GroupAddParticipants')!;
    const out = (await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us', participants: ['628111@c.us', '628222@c.us'] },
      'key',
      makeAuth() as unknown as AuthService,
    )) as { success: boolean; message: string; results: ParticipantOperationResult[] };

    expect(addParticipants).toHaveBeenCalledWith('s1', '120363@g.us', ['628111@c.us', '628222@c.us']);
    // Partial batch: success stays true (one did join) but the message must not claim a clean run.
    expect(out.success).toBe(true);
    expect(out.message).toContain('1/2');
    expect(out.results).toEqual(results);
  });

  it('reports failure when every participant was refused', async () => {
    // An agent reading only the top-level fields was previously told "Participants added" even when
    // nothing happened.
    const results: ParticipantOperationResult[] = [
      { id: '628111@c.us', success: false, status: 404, message: 'not registered' },
      { id: '628222@c.us', success: false, status: 409, message: 'already a member' },
    ];
    const groupSvc = { addParticipants: jest.fn().mockResolvedValue(results) } as unknown as GroupService;

    const tool = groupTools(groupSvc).find(t => t.name === 'GroupAddParticipants')!;
    const out = (await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us', participants: ['628111@c.us', '628222@c.us'] },
      'key',
      makeAuth() as unknown as AuthService,
    )) as { success: boolean; message: string };

    expect(out.success).toBe(false);
    expect(out.message).toContain('0/2');
  });

  it('reports a clean success when every participant joined', async () => {
    const results: ParticipantOperationResult[] = [{ id: '628111@c.us', success: true, status: 200 }];
    const groupSvc = { addParticipants: jest.fn().mockResolvedValue(results) } as unknown as GroupService;

    const tool = groupTools(groupSvc).find(t => t.name === 'GroupAddParticipants')!;
    const out = (await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us', participants: ['628111@c.us'] },
      'key',
      makeAuth() as unknown as AuthService,
    )) as { success: boolean; message: string };

    expect(out).toEqual({ success: true, message: 'Participants added', results });
  });
});

describe('groupTools execute handlers', () => {
  it('GroupFindAll delegates to getGroups with paging', async () => {
    const getGroups = jest.fn().mockResolvedValue([{ id: 'g1' }]);
    const tool = groupTools({ getGroups } as unknown as GroupService).find(t => t.name === 'GroupFindAll')!;
    const out = await invokeTool(
      tool,
      { sessionId: 's1', limit: 10, offset: 5 },
      'key',
      makeAuth() as unknown as AuthService,
    );
    expect(getGroups).toHaveBeenCalledWith('s1', { limit: 10, offset: 5 });
    expect(out).toEqual([{ id: 'g1' }]);
  });

  it('GroupFindOne delegates to getGroupInfo', async () => {
    const getGroupInfo = jest.fn().mockResolvedValue({ id: 'g1' });
    const tool = groupTools({ getGroupInfo } as unknown as GroupService).find(t => t.name === 'GroupFindOne')!;
    const out = await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us' },
      'key',
      makeAuth() as unknown as AuthService,
    );
    expect(getGroupInfo).toHaveBeenCalledWith('s1', '120363@g.us');
    expect(out).toEqual({ id: 'g1' });
  });

  it('GroupGetInviteCode maps the code to code + link', async () => {
    const getGroupInviteCode = jest.fn().mockResolvedValue('abc123');
    const tool = groupTools({ getGroupInviteCode } as unknown as GroupService).find(
      t => t.name === 'GroupGetInviteCode',
    )!;
    const out = await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us' },
      'key',
      makeAuth() as unknown as AuthService,
    );
    expect(getGroupInviteCode).toHaveBeenCalledWith('s1', '120363@g.us');
    expect(out).toEqual({ inviteCode: 'abc123', inviteLink: 'https://chat.whatsapp.com/abc123' });
  });

  it('GroupCreate delegates to createGroup', async () => {
    const createGroup = jest.fn().mockResolvedValue({ id: 'g1' });
    const tool = groupTools({ createGroup } as unknown as GroupService).find(t => t.name === 'GroupCreate')!;
    const out = await invokeTool(
      tool,
      { sessionId: 's1', name: 'New group', participants: ['628111@c.us'] },
      'key',
      makeAuth() as unknown as AuthService,
    );
    expect(createGroup).toHaveBeenCalledWith('s1', 'New group', ['628111@c.us']);
    expect(out).toEqual({ id: 'g1' });
  });

  it('GroupSetSubject delegates to setGroupSubject and reports success', async () => {
    const setGroupSubject = jest.fn().mockResolvedValue(undefined);
    const tool = groupTools({ setGroupSubject } as unknown as GroupService).find(t => t.name === 'GroupSetSubject')!;
    const out = await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us', subject: 'Renamed' },
      'key',
      makeAuth() as unknown as AuthService,
    );
    expect(setGroupSubject).toHaveBeenCalledWith('s1', '120363@g.us', 'Renamed');
    expect(out).toEqual({ success: true, message: 'Group subject updated' });
  });

  it('GroupSetDescription delegates to setGroupDescription and reports success', async () => {
    const setGroupDescription = jest.fn().mockResolvedValue(undefined);
    const tool = groupTools({ setGroupDescription } as unknown as GroupService).find(
      t => t.name === 'GroupSetDescription',
    )!;
    const out = await invokeTool(
      tool,
      { sessionId: 's1', groupId: '120363@g.us', description: 'About us' },
      'key',
      makeAuth() as unknown as AuthService,
    );
    expect(setGroupDescription).toHaveBeenCalledWith('s1', '120363@g.us', 'About us');
    expect(out).toEqual({ success: true, message: 'Group description updated' });
  });
});
