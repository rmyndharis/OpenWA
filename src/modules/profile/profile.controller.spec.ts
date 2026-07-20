import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

describe('ProfileController', () => {
  const build = (service: Partial<Record<keyof ProfileService, jest.Mock>>) => {
    const controller = new ProfileController(service as unknown as ProfileService);
    return { controller, service };
  };

  it('PUT name delegates and returns the success envelope', async () => {
    const { controller, service } = build({ setProfileName: jest.fn().mockResolvedValue(undefined) });
    await expect(controller.setName('s1', { name: 'New Name' })).resolves.toEqual({
      success: true,
      message: 'Profile name updated',
    });
    expect(service.setProfileName).toHaveBeenCalledWith('s1', 'New Name');
  });

  it('PUT status delegates and returns the success envelope', async () => {
    const { controller, service } = build({ setProfileStatus: jest.fn().mockResolvedValue(undefined) });
    await expect(controller.setStatus('s1', { status: 'busy' })).resolves.toEqual({
      success: true,
      message: 'Profile status updated',
    });
    expect(service.setProfileStatus).toHaveBeenCalledWith('s1', 'busy');
  });

  it('PUT picture forwards the media body unchanged and returns the success envelope', async () => {
    const { controller, service } = build({ setProfilePicture: jest.fn().mockResolvedValue(undefined) });
    const dto = { base64: 'QUJD', mimetype: 'image/png' };
    await expect(controller.setPicture('s1', dto)).resolves.toEqual({
      success: true,
      message: 'Profile picture updated',
    });
    expect(service.setProfilePicture).toHaveBeenCalledWith('s1', dto);
  });
});
