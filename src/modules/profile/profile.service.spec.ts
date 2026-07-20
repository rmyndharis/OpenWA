import { BadRequestException } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine, MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ProfileService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService;
    return new ProfileService(sessionService);
  };

  it('throws 400 "Session is not started" when the engine is missing (guard preserved)', () => {
    const svc = makeService(undefined);
    expect(() => svc.setProfileName('s1', 'Name')).toThrow(BadRequestException);
    expect(() => svc.setProfileName('s1', 'Name')).toThrow('Session is not started');
  });

  it('setProfileName delegates to the engine', async () => {
    const setProfileName = jest.fn().mockResolvedValue(undefined);
    await makeService({ setProfileName }).setProfileName('s1', 'New Name');
    expect(setProfileName).toHaveBeenCalledWith('New Name');
  });

  it('setProfileStatus delegates to the engine (empty string clears the about)', async () => {
    const setProfileStatus = jest.fn().mockResolvedValue(undefined);
    await makeService({ setProfileStatus }).setProfileStatus('s1', '');
    expect(setProfileStatus).toHaveBeenCalledWith('');
  });

  describe('setProfilePicture', () => {
    it('rejects a body with neither url nor base64 (400)', () => {
      // The guard throws synchronously (the service method is a thin sync pass-through, like GroupService).
      const svc = makeService({ setProfilePicture: jest.fn() });
      expect(() => svc.setProfilePicture('s1', {})).toThrow('Either url or base64 must be provided');
    });

    it('requires mimetype when base64 is used (400)', () => {
      const svc = makeService({ setProfilePicture: jest.fn() });
      expect(() => svc.setProfilePicture('s1', { base64: 'QUJD' })).toThrow(
        'mimetype is required when using base64 data',
      );
    });

    it('maps a base64 body to a MediaInput (base64 wins over a stale url, #670)', async () => {
      const setProfilePicture = jest.fn().mockResolvedValue(undefined);
      await makeService({ setProfilePicture }).setProfilePicture('s1', {
        base64: 'QUJD',
        mimetype: 'image/png',
        url: 'https://example.com/stale.jpg',
      });
      const calls = setProfilePicture.mock.calls as Array<[MediaInput]>;
      expect(calls[0][0]).toEqual({ mimetype: 'image/png', data: 'QUJD' });
    });

    it('maps a url body to a MediaInput with the default image mimetype', async () => {
      const setProfilePicture = jest.fn().mockResolvedValue(undefined);
      await makeService({ setProfilePicture }).setProfilePicture('s1', { url: 'https://example.com/a.jpg' });
      expect(setProfilePicture).toHaveBeenCalledWith({ mimetype: 'image/jpeg', data: 'https://example.com/a.jpg' });
    });

    it('accepts a data: URI base64 payload (prefix stripped like the message module)', async () => {
      const setProfilePicture = jest.fn().mockResolvedValue(undefined);
      await makeService({ setProfilePicture }).setProfilePicture('s1', {
        base64: 'data:image/png;base64,QUJD',
        mimetype: 'image/png',
      });
      expect(setProfilePicture).toHaveBeenCalledWith({ mimetype: 'image/png', data: 'QUJD' });
    });
  });
});
