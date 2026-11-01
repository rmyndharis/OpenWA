import { BadRequestException } from '@nestjs/common';
import { SendPacingService } from '../message/send-pacing.service';
import { GroupService } from './group.service';

describe('GroupService picture methods canonicalize groupId before calling the engine', () => {
  it.each(['120363000000000001@G.US', ' 120363000000000001@g.us ', '120363000000000001:5@g.us'])(
    'forwards canonical 120363000000000001@g.us to getProfilePicture, setGroupPicture, and deleteGroupPicture for %s',
    async rawGroupId => {
      const engine = {
        getProfilePicture: jest.fn().mockResolvedValue('https://pic'),
        setGroupPicture: jest.fn().mockResolvedValue(undefined),
        deleteGroupPicture: jest.fn().mockResolvedValue(undefined),
      };
      const engines = {
        require: jest.fn().mockReturnValue(engine),
      };
      const service = new GroupService(engines as never, {} as SendPacingService);
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

      await service.getGroupPicture('s1', rawGroupId);
      await service.setGroupPicture('s1', rawGroupId, {
        base64: pngBuffer.toString('base64'),
        mimetype: 'image/jpeg',
      });
      await service.deleteGroupPicture('s1', rawGroupId);

      expect(engine.getProfilePicture).toHaveBeenCalledWith('120363000000000001@g.us');
      expect(engine.setGroupPicture).toHaveBeenCalledWith('120363000000000001@g.us', {
        mimetype: 'image/jpeg',
        data: pngBuffer.toString('base64'),
      });
      expect(engine.deleteGroupPicture).toHaveBeenCalledWith('120363000000000001@g.us');
    },
  );

  it.each(['628123456789@c.us', '@g.us', '628123456789:0@c.us@g.us'])(
    'still rejects non-group or malformed groupId %s before calling the engine',
    invalidGroupId => {
      const engine = {
        getProfilePicture: jest.fn(),
        setGroupPicture: jest.fn(),
        deleteGroupPicture: jest.fn(),
      };
      const engines = {
        require: jest.fn().mockReturnValue(engine),
      };
      const service = new GroupService(engines as never, {} as SendPacingService);

      expect(() => service.getGroupPicture('s1', invalidGroupId)).toThrow(BadRequestException);
      expect(() =>
        service.setGroupPicture('s1', invalidGroupId, {
          base64: 'QUJD',
          mimetype: 'image/jpeg',
        }),
      ).toThrow(BadRequestException);
      expect(() => service.deleteGroupPicture('s1', invalidGroupId)).toThrow(BadRequestException);
      expect(engine.getProfilePicture).not.toHaveBeenCalled();
      expect(engine.setGroupPicture).not.toHaveBeenCalled();
      expect(engine.deleteGroupPicture).not.toHaveBeenCalled();
    },
  );
});
