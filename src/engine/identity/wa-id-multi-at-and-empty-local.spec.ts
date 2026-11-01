import { BadRequestException } from '@nestjs/common';
import { ChatScopeService } from '../../modules/auth/chat-scope.service';
import { isChatId } from '../../modules/auth/dto/is-chat-id.validator';
import { GroupService } from '../../modules/group/group.service';
import { SendPacingService } from '../../modules/message/send-pacing.service';
import { resolveJidCandidates } from './jid-candidates';
import { chatKind, isAddressableParticipant, isChannelJid, isIndividualWid, parseWaId } from './wa-id';

describe('parseWaId multi-@ and empty local part handling', () => {
  it('rejects multi-@ JIDs with a colon before the first @ across parseWaId, resolveJidCandidates, and ChatScopeService', async () => {
    const craftedGroup = '120363111111111111:0@s.whatsapp.net@g.us';
    const craftedUser = '628111111111:0@g.us@c.us';

    expect(parseWaId(craftedGroup)).toEqual({
      kind: 'unknown',
      userPart: '',
      raw: craftedGroup,
    });
    expect(parseWaId(craftedUser)).toEqual({
      kind: 'unknown',
      userPart: '',
      raw: craftedUser,
    });

    await expect(resolveJidCandidates(craftedGroup)).resolves.toEqual([craftedGroup]);
    await expect(resolveJidCandidates(craftedUser)).resolves.toEqual([craftedUser]);

    const scopeService = new ChatScopeService();
    await expect(scopeService.allows({ allowedChats: ['120363111111111111@g.us'] }, craftedGroup)).resolves.toBe(false);
    await expect(scopeService.allows({ allowedChats: ['628111111111@c.us'] }, craftedUser)).resolves.toBe(false);
  });

  it('rejects multi-@ JIDs with a colon in isIndividualWid, isAddressableParticipant, and isChatId', () => {
    expect(isIndividualWid('628111111111:0@g.us@c.us')).toBe(false);
    expect(isAddressableParticipant('628111111111:0@g.us@c.us')).toBe(false);
    expect(isAddressableParticipant('123456789012345:0@g.us@lid')).toBe(false);
    expect(isChatId('628111111111:0@g.us@c.us')).toBe(false);
    expect(isChatId('123456789012345:0@g.us@lid')).toBe(false);
    expect(isChatId('120363111111111111:0@s.whatsapp.net@g.us')).toBe(false);
  });

  it('rejects bare server suffixes with an empty userPart such as @g.us, :5@g.us, and @newsletter', async () => {
    expect(chatKind('@g.us')).toBe('unknown');
    expect(chatKind(' @g.us ')).toBe('unknown');
    expect(chatKind(':5@g.us')).toBe('unknown');
    expect(chatKind('@newsletter')).toBe('unknown');
    expect(chatKind('@broadcast')).toBe('unknown');
    expect(isChannelJid('@newsletter')).toBe(false);

    const engine = {
      setGroupMemberLabel: jest.fn().mockResolvedValue(undefined),
      getProfilePicture: jest.fn().mockResolvedValue(null),
      setGroupPicture: jest.fn().mockResolvedValue(undefined),
      deleteGroupPicture: jest.fn().mockResolvedValue(undefined),
    };
    const engines = {
      require: jest.fn().mockReturnValue(engine),
    };
    const service = new GroupService(engines as never, {} as SendPacingService);

    await expect(async () => service.setGroupMemberLabel('s1', '@g.us', 'Coach')).rejects.toThrow(BadRequestException);
    await expect(async () => service.setGroupMemberLabel('s1', ':5@g.us', 'Coach')).rejects.toThrow(
      BadRequestException,
    );
    await expect(async () => service.getGroupPicture('s1', '@g.us')).rejects.toThrow(BadRequestException);
    await expect(async () => service.deleteGroupPicture('s1', ':5@g.us')).rejects.toThrow(BadRequestException);
    expect(engine.setGroupMemberLabel).not.toHaveBeenCalled();
    expect(engine.getProfilePicture).not.toHaveBeenCalled();
    expect(engine.deleteGroupPicture).not.toHaveBeenCalled();
  });

  it('preserves valid single-@ JIDs with and without device suffixes', async () => {
    expect(parseWaId('120363111111111111:5@g.us')).toEqual({
      kind: 'group',
      userPart: '120363111111111111',
      device: '5',
      raw: '120363111111111111:5@g.us',
    });
    expect(isIndividualWid('628111111111:2@s.whatsapp.net')).toBe(true);
    expect(isAddressableParticipant('123456789012345:3@lid')).toBe(true);
    expect(isChatId('120363111111111111@g.us')).toBe(true);
    expect(isChatId('628111111111:2@s.whatsapp.net')).toBe(true);
    expect(isChannelJid('120363000000000001@newsletter')).toBe(true);
    await expect(resolveJidCandidates('120363111111111111:5@g.us')).resolves.toEqual(['120363111111111111@g.us']);
  });
});
