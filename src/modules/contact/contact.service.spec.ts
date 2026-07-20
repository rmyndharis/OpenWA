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

  it('batch-resolves profile pictures, nulling per-id failures without aborting', async () => {
    const getProfilePicture = jest
      .fn()
      .mockResolvedValueOnce('https://pps/1.jpg')
      .mockRejectedValueOnce(new Error('no picture'))
      .mockResolvedValueOnce('https://pps/3.jpg');
    const out = await makeService({ getProfilePicture }).getProfilePictures('s1', ['a@c.us', 'b@c.us', 'c@c.us']);
    expect(out).toEqual({ 'a@c.us': 'https://pps/1.jpg', 'b@c.us': null, 'c@c.us': 'https://pps/3.jpg' });
  });

  it('ignores ids beyond the 50-id batch cap', async () => {
    const getProfilePicture = jest.fn().mockResolvedValue(null);
    const ids = Array.from({ length: 60 }, (_, i) => `${i}@c.us`);
    const out = await makeService({ getProfilePicture }).getProfilePictures('s1', ids);
    expect(Object.keys(out)).toHaveLength(50);
    expect(getProfilePicture).toHaveBeenCalledTimes(50);
  });

  it('runs batch lookups at most 5 concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const getProfilePicture = jest.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setImmediate(r));
      active -= 1;
      return null;
    });
    const ids = Array.from({ length: 12 }, (_, i) => `${i}@c.us`);
    await makeService({ getProfilePicture }).getProfilePictures('s1', ids);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('yields null (not a stalled batch) when an engine lookup hangs past the per-id deadline', async () => {
    const getProfilePicture = jest
      .fn()
      .mockResolvedValueOnce('https://pps/1.jpg')
      .mockImplementationOnce(() => new Promise(() => undefined)); // never settles
    const started = Date.now();
    const out = await makeService({ getProfilePicture }).getProfilePictures('s1', ['a@c.us', 'b@c.us']);
    expect(out).toEqual({ 'a@c.us': 'https://pps/1.jpg', 'b@c.us': null });
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 15_000);
});
