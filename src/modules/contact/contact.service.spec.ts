import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ContactService } from './contact.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ContactService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const engines = new EngineRegistry();
    if (engine) engines.set('s1', engine as IWhatsAppEngine);
    return new ContactService(engines);
  };

  it('throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).getContacts('s1')).toThrow(BadRequestException);
  });

  it('getBlockedContacts delegates to the engine and returns the bare id list', async () => {
    const getBlockedContacts = jest.fn().mockResolvedValue(['628111@c.us']);
    await expect(makeService({ getBlockedContacts }).getBlockedContacts('s1')).resolves.toEqual(['628111@c.us']);
    expect(getBlockedContacts).toHaveBeenCalledTimes(1);
  });

  it('getBlockedContacts throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).getBlockedContacts('s1')).toThrow(BadRequestException);
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

  describe('block/unblock reject ids that do not name a person', () => {
    // whatsapp-web.js's Contact.block()/unblock() return false for a group id (nothing blocked,
    // answered 200 "blocked"); Baileys hands the id to updateBlockStatus whose Boom for an
    // unresolvable jid surfaces as an opaque 500. Both engines share this 400 guard.
    it.each([
      ['blockContact', (svc: ContactService) => svc.blockContact('s1', '120363000000000000@g.us')],
      ['unblockContact', (svc: ContactService) => svc.unblockContact('s1', '120363000000000000@g.us')],
      ['blockContact (newsletter)', (svc: ContactService) => svc.blockContact('s1', '1200000000@newsletter')],
      ['blockContact (broadcast)', (svc: ContactService) => svc.blockContact('s1', '1200000000@broadcast')],
      ['blockContact (status)', (svc: ContactService) => svc.blockContact('s1', 'status@broadcast')],
      ['blockContact (free text)', (svc: ContactService) => svc.blockContact('s1', 'hello@c.us')],
    ])('%s refuses the id with a 400 before the engine is called', (_name, call) => {
      const blockContact = jest.fn();
      const unblockContact = jest.fn();
      const svc = makeService({ blockContact, unblockContact });
      expect(() => call(svc)).toThrow(BadRequestException);
      expect(blockContact).not.toHaveBeenCalled();
      expect(unblockContact).not.toHaveBeenCalled();
    });

    /**
     * A Meta-hosted id names the same account as its plain twin, so the write must reach the engine
     * rather than be refused. It is neutralized on the way there: whatsapp-web.js knows no `@hosted`
     * domain, so forwarding the suffix verbatim would fail inside the page instead of blocking anyone.
     */
    it('accepts a Meta-hosted id and hands the engine the neutral dialect', async () => {
      const blockContact = jest.fn().mockResolvedValue(undefined);
      const unblockContact = jest.fn().mockResolvedValue(undefined);
      const svc = makeService({ blockContact, unblockContact });

      await svc.blockContact('s1', '628123456789@hosted');
      await svc.unblockContact('s1', '12345678901234567890@hosted.lid');

      expect(blockContact).toHaveBeenCalledWith('628123456789@c.us');
      expect(unblockContact).toHaveBeenCalledWith('12345678901234567890@lid');
    });

    /**
     * Neutralizing covers the raw-protocol dialect too, which used to reach the engine verbatim.
     * That is a round trip, not a loss: the Baileys adapter hands the jid to `updateBlockStatus`,
     * which starts with `jidNormalizedUser` and turns `@c.us` straight back into `@s.whatsapp.net`.
     * whatsapp-web.js, which has no such dialect, gets the form it actually understands.
     */
    it('hands the engine the neutral dialect for a raw-protocol id', async () => {
      const blockContact = jest.fn().mockResolvedValue(undefined);
      const svc = makeService({ blockContact });

      await svc.blockContact('s1', '628123456789@s.whatsapp.net');

      expect(blockContact).toHaveBeenCalledWith('628123456789@c.us');
    });

    /**
     * A privacy-id contact has no phone number at all, and the blocklist READ answers those ids
     * verbatim (Baileys maps each blocked jid through toNeutralJid, which leaves an unresolved lid
     * as `<lid>@lid`; whatsapp-web.js returns the wid as-is). Refusing them here made the ids the
     * API itself hands out unusable for the matching write, so a privacy-id contact could be listed
     * as blocked and never unblocked. Blocking acts on the identity, not on an addressbook row, so
     * neither engine needs a phone here: Baileys passes the jid straight to updateBlockStatus, and
     * whatsapp-web.js only short-circuits (`return false`) for a group.
     */
    it.each([
      ['blockContact', (svc: ContactService) => svc.blockContact('s1', '159442138038327@lid')],
      ['unblockContact', (svc: ContactService) => svc.unblockContact('s1', '159442138038327@lid')],
    ])('%s forwards a privacy id (@lid) to the engine unchanged', async (_name, call) => {
      const blockContact = jest.fn().mockResolvedValue(undefined);
      const unblockContact = jest.fn().mockResolvedValue(undefined);
      await call(makeService({ blockContact, unblockContact }));
      const called = blockContact.mock.calls.length ? blockContact : unblockContact;
      expect(called).toHaveBeenCalledWith('159442138038327@lid');
    });

    it('accepts every id shape the blocklist read can return', async () => {
      // The read half answers ids only, so whatever it lists must be feedable back to unblock.
      const getBlockedContacts = jest.fn().mockResolvedValue(['628123@c.us', '159442138038327@lid']);
      const unblockContact = jest.fn().mockResolvedValue(undefined);
      const svc = makeService({ getBlockedContacts, unblockContact });
      for (const id of await svc.getBlockedContacts('s1')) {
        await svc.unblockContact('s1', id);
      }
      expect(unblockContact).toHaveBeenCalledWith('628123@c.us');
      expect(unblockContact).toHaveBeenCalledWith('159442138038327@lid');
    });

    it('qualifies a bare number and forwards it to the engine as a @c.us id', async () => {
      const blockContact = jest.fn().mockResolvedValue(undefined);
      await makeService({ blockContact }).blockContact('s1', '628123');
      expect(blockContact).toHaveBeenCalledWith('628123@c.us');
    });

    it('still allows a normal phone-based contact id through to the engine', async () => {
      const unblockContact = jest.fn().mockResolvedValue(undefined);
      await makeService({ unblockContact }).unblockContact('s1', '628123@c.us');
      expect(unblockContact).toHaveBeenCalledWith('628123@c.us');
    });
  });

  describe('addressbook writes reject a privacy id', () => {
    // The lid's digits are NOT a phone number (see the note on
    // MessageService.resolveJidCandidates). whatsapp-web.js takes a bare NUMBER for the
    // addressbook, so an unguarded @lid would be stored as if it were a real phone —
    // silently creating an entry for a number that does not exist.
    it.each([
      ['upsertContact', (svc: ContactService) => svc.upsertContact('s1', '159442138038327@lid', 'Ada')],
      ['deleteContact', (svc: ContactService) => svc.deleteContact('s1', '159442138038327@lid')],
    ])('%s refuses an @lid contact id with a 400', (_name, call) => {
      const upsertContact = jest.fn();
      const deleteContact = jest.fn();
      const svc = makeService({ upsertContact, deleteContact });
      expect(() => call(svc)).toThrow(BadRequestException);
      expect(upsertContact).not.toHaveBeenCalled();
      expect(deleteContact).not.toHaveBeenCalled();
    });

    it('still allows a normal phone-based contact id through to the engine', async () => {
      const upsertContact = jest.fn().mockResolvedValue(undefined);
      await makeService({ upsertContact }).upsertContact('s1', '628123@c.us', 'Ada', 'Lovelace');
      expect(upsertContact).toHaveBeenCalledWith('628123@c.us', 'Ada', 'Lovelace');
    });

    // Same hazard as the lid, different ids: a group/newsletter/broadcast id also carries digits
    // that would be stored as a phone number for a contact that does not exist.
    it.each(['120363000000000000@g.us', '120363000000000000@newsletter', 'status@broadcast'])(
      'refuses the non-person id %s with a 400',
      id => {
        const upsertContact = jest.fn();
        const svc = makeService({ upsertContact });
        expect(() => svc.upsertContact('s1', id, 'Ada')).toThrow(BadRequestException);
        expect(upsertContact).not.toHaveBeenCalled();
      },
    );

    /**
     * The guard checked the JID DOMAIN only: `parseWaId(id).kind === 'user'` holds for anything
     * ending in `@c.us` / `@s.whatsapp.net` whatever its user-part. So free text reached the engine
     * and the caller was told the contact was saved — while the three sibling surfaces on the same
     * shapes (group participants, channel admin, message mentions) reject exactly these strings
     * through isAddressableParticipant, which also requires the user-part to be numeric.
     */
    it.each([
      ['free text', 'NOT A USER@c.us'],
      ['letters', 'abc@c.us'],
      ['an empty user-part', '@c.us'],
      ['the engine dialect with free text', 'abc@s.whatsapp.net'],
    ])('refuses %s without reaching the engine', (_label, id) => {
      const upsertContact = jest.fn();
      const deleteContact = jest.fn();
      const svc = makeService({ upsertContact, deleteContact });

      expect(() => svc.upsertContact('s1', id, 'Ada')).toThrow(BadRequestException);
      expect(() => svc.deleteContact('s1', id)).toThrow(BadRequestException);
      expect(upsertContact).not.toHaveBeenCalled();
      expect(deleteContact).not.toHaveBeenCalled();
    });

    // Negative twin: the ids this route exists to serve must still pass.
    it.each([
      ['a phone jid', '628123456789@c.us'],
      ['the engine dialect', '628123456789@s.whatsapp.net'],
      ['a bare number', '628123456789'],
    ])('still accepts %s', async (_label, id) => {
      const upsertContact = jest.fn();
      await makeService({ upsertContact }).upsertContact('s1', id, 'Ada');
      expect(upsertContact).toHaveBeenCalled();
    });
  });

  describe('resolveContactPhone error contract', () => {
    it('propagates the 400 when the session is not started (getEngine is outside the swallow)', async () => {
      const svc = makeService(undefined);
      await expect(svc.resolveContactPhone('s1', '123@lid')).rejects.toThrow('Session is not started');
    });

    it('propagates an HttpException from the engine (409 not-ready keeps its retry guidance)', async () => {
      const svc = makeService({
        resolveContactPhone: jest.fn().mockRejectedValue(new ConflictException('Session is not connected')),
      });
      await expect(svc.resolveContactPhone('s1', '123@lid')).rejects.toBeInstanceOf(ConflictException);
    });

    it('returns null for a non-HTTP lookup failure (dead page), preserving the route contract', async () => {
      const svc = makeService({
        resolveContactPhone: jest.fn().mockRejectedValue(new Error('Protocol error: Target closed')),
      });
      await expect(svc.resolveContactPhone('s1', '123@lid')).resolves.toBeNull();
    });
  });

  describe('resolveContactPhone null-on-failure boundary', () => {
    it('returns null (200 contract) when the engine lookup throws', async () => {
      const svc = makeService({
        resolveContactPhone: jest.fn().mockRejectedValue(new Error('Protocol error: Target closed')),
      });
      await expect(svc.resolveContactPhone('s1', '123@lid')).resolves.toBeNull();
    });

    it('returns the engine answer verbatim on success', async () => {
      const svc = makeService({ resolveContactPhone: jest.fn().mockResolvedValue('628123') });
      await expect(svc.resolveContactPhone('s1', '123@lid')).resolves.toBe('628123');
    });
  });
});
