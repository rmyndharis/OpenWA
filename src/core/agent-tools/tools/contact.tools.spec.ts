import { invokeTool } from '../tool-invoker';
import { contactTools } from './contact.tools';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { ContactService } from '../../../modules/contact/contact.service';
import type { AuthService } from '../../../modules/auth/auth.service';

// Covers every contactTools execute() handler via the real invokeTool path (auth → zod → handler).
// agent-tools.module.ts is pure Nest wiring, stays at 0% coverage, and is intentionally not a target.

function makeAuth(): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

function makeTools(svc: ContactService): Map<string, AnyToolDescriptor> {
  return new Map(contactTools(svc).map(t => [t.name, t]));
}

async function run(tool: AnyToolDescriptor, input: unknown): Promise<unknown> {
  return invokeTool(tool, input, 'key', makeAuth() as unknown as AuthService);
}

describe('contactTools', () => {
  it('ContactFindAll delegates to getContacts with paging', async () => {
    const getContacts = jest.fn().mockResolvedValue([{ id: 'c1' }]);
    const out = await run(makeTools({ getContacts } as unknown as ContactService).get('ContactFindAll')!, {
      sessionId: 's1',
      limit: 10,
      offset: 5,
    });
    expect(getContacts).toHaveBeenCalledWith('s1', { limit: 10, offset: 5 });
    expect(out).toEqual([{ id: 'c1' }]);
  });

  it('ContactFindOne delegates to getContactById', async () => {
    const getContactById = jest.fn().mockResolvedValue({ id: 'c1' });
    const out = await run(makeTools({ getContactById } as unknown as ContactService).get('ContactFindOne')!, {
      sessionId: 's1',
      contactId: '628123@c.us',
    });
    expect(getContactById).toHaveBeenCalledWith('s1', '628123@c.us');
    expect(out).toEqual({ id: 'c1' });
  });

  it('ContactCheckNumber maps a found JID to exists:true', async () => {
    const getNumberId = jest.fn().mockResolvedValue('628123@c.us');
    const out = await run(makeTools({ getNumberId } as unknown as ContactService).get('ContactCheckNumber')!, {
      sessionId: 's1',
      number: '628123',
    });
    expect(getNumberId).toHaveBeenCalledWith('s1', '628123');
    expect(out).toEqual({ number: '628123', exists: true, whatsappId: '628123@c.us' });
  });

  it('ContactCheckNumber maps a null JID to exists:false', async () => {
    const getNumberId = jest.fn().mockResolvedValue(null);
    const out = await run(makeTools({ getNumberId } as unknown as ContactService).get('ContactCheckNumber')!, {
      sessionId: 's1',
      number: '628123',
    });
    expect(out).toEqual({ number: '628123', exists: false, whatsappId: null });
  });

  it('ContactResolvePhone delegates to resolveContactPhone', async () => {
    const resolveContactPhone = jest.fn().mockResolvedValue('628123');
    const out = await run(makeTools({ resolveContactPhone } as unknown as ContactService).get('ContactResolvePhone')!, {
      sessionId: 's1',
      contactId: '12345@lid',
    });
    expect(resolveContactPhone).toHaveBeenCalledWith('s1', '12345@lid');
    expect(out).toEqual({ contactId: '12345@lid', phone: '628123' });
  });

  it('ContactGetProfilePicture maps the service result to a url field', async () => {
    const getProfilePicture = jest.fn().mockResolvedValue('https://example.com/pic.jpg');
    const out = await run(
      makeTools({ getProfilePicture } as unknown as ContactService).get('ContactGetProfilePicture')!,
      { sessionId: 's1', contactId: '628123@c.us' },
    );
    expect(getProfilePicture).toHaveBeenCalledWith('s1', '628123@c.us');
    expect(out).toEqual({ url: 'https://example.com/pic.jpg' });
  });

  it('ContactBlock delegates to blockContact and reports success', async () => {
    const blockContact = jest.fn().mockResolvedValue(undefined);
    const out = await run(makeTools({ blockContact } as unknown as ContactService).get('ContactBlock')!, {
      sessionId: 's1',
      contactId: '628123@c.us',
    });
    expect(blockContact).toHaveBeenCalledWith('s1', '628123@c.us');
    expect(out).toEqual({ success: true, message: 'Contact blocked' });
  });

  it('ContactUnblock delegates to unblockContact and reports success', async () => {
    const unblockContact = jest.fn().mockResolvedValue(undefined);
    const out = await run(makeTools({ unblockContact } as unknown as ContactService).get('ContactUnblock')!, {
      sessionId: 's1',
      contactId: '628123@c.us',
    });
    expect(unblockContact).toHaveBeenCalledWith('s1', '628123@c.us');
    expect(out).toEqual({ success: true, message: 'Contact unblocked' });
  });
});
