import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactService } from './contact.service';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ContactService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService;
    return new ContactService(sessionService);
  };

  it('throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).getContacts('s1')).toThrow(BadRequestException);
  });

  it('caps an unbounded contacts list at the default limit (1000)', async () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({ id: `${i}@c.us` }));
    const getContacts = jest.fn().mockResolvedValue(big);
    await expect(makeService({ getContacts }).getContacts('s1')).resolves.toHaveLength(1000);
  });

  it('applies limit/offset to the contacts list', async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: `${i}@c.us` }));
    const getContacts = jest.fn().mockResolvedValue(big);
    const page = (await makeService({ getContacts }).getContacts('s1', { limit: 5, offset: 10 })) as { id: string }[];
    expect(page).toHaveLength(5);
    expect(page[0].id).toBe('10@c.us');
  });

  it('maps a missing contact to 404', async () => {
    const svc = makeService({ getContactById: jest.fn().mockResolvedValue(null) });
    await expect(svc.getContactById('s1', 'c404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delegates checkNumberExists to the engine', async () => {
    const checkNumberExists = jest.fn().mockResolvedValue(true);
    await expect(makeService({ checkNumberExists }).checkNumberExists('s1', '628123')).resolves.toBe(true);
    expect(checkNumberExists).toHaveBeenCalledWith('628123');
  });

  it('delegates getNumberId to the engine (canonical JID resolution)', async () => {
    const getNumberId = jest.fn().mockResolvedValue('628123@c.us');
    await expect(makeService({ getNumberId }).getNumberId('s1', '628123')).resolves.toBe('628123@c.us');
    expect(getNumberId).toHaveBeenCalledWith('628123');
  });

  it('delegates resolveContactPhone to the engine', async () => {
    const resolveContactPhone = jest.fn().mockResolvedValue('628123456789');
    await expect(makeService({ resolveContactPhone }).resolveContactPhone('s1', '123@lid')).resolves.toBe(
      '628123456789',
    );
    expect(resolveContactPhone).toHaveBeenCalledWith('123@lid');
  });
});
