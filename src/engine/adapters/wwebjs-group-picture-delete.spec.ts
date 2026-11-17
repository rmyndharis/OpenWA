import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * `GroupChat.deletePicture` has three answers: `true` when WhatsApp removed the picture, `false` when it refused, and
 * nothing at all when WhatsApp Web did not attempt the delete, which it does for a group with no picture and for an
 * account that may not edit the group's info. On a live session a second delete by an admin answers nothing, so for
 * an account that may edit the info "not attempted" means there was nothing to delete, and a repeat converges to a
 * success once WhatsApp itself reports no picture: the page answers from its own copy, which can be out of date.
 * Where the account may not edit the info, or that cannot be read, it stays a refusal.
 */
describe('whatsapp-web.js delete of a group picture that WhatsApp Web did not attempt', () => {
  const GROUP = '120363000000000001@g.us';
  const SELF = '628000000001@c.us';
  const OTHER = '628111222333@c.us';

  type Self = { isAdmin: boolean; isSuperAdmin: boolean } | null;

  function setup(answer: boolean | undefined, self: Self, restrict?: boolean, picture?: string | Error) {
    const participants = [{ id: { _serialized: OTHER, user: '628111222333' }, isAdmin: true, isSuperAdmin: true }];
    if (self) participants.push({ id: { _serialized: SELF, user: '628000000001' }, ...self });
    const deletePicture = jest.fn().mockResolvedValue(answer);
    const getProfilePicUrl =
      picture instanceof Error ? jest.fn().mockRejectedValue(picture) : jest.fn().mockResolvedValue(picture);
    const chat = {
      id: { _serialized: GROUP },
      isGroup: true,
      participants,
      groupMetadata: restrict === undefined ? {} : { restrict },
      deletePicture,
    };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: { wid: { _serialized: SELF, user: '628000000001' } },
      getChatById: jest.fn().mockResolvedValue(chat),
      // What WhatsApp holds for the group: a url, or nothing.
      getProfilePicUrl,
    };
    return { adapter, deletePicture, getProfilePicUrl };
  }

  const admin = { isAdmin: true, isSuperAdmin: false };
  const owner = { isAdmin: false, isSuperAdmin: true };
  const member = { isAdmin: false, isSuperAdmin: false };

  it.each([
    ['an admin', admin, true],
    ['the owner', owner, true],
    ['a member of a group whose info every member may edit', member, false],
  ])('succeeds for %s: there was no picture to delete', async (_who, self, restrict) => {
    const { adapter, deletePicture, getProfilePicUrl } = setup(undefined, self, restrict);

    await expect(adapter.deleteGroupPicture(GROUP)).resolves.toBeUndefined();
    expect(deletePicture).toHaveBeenCalledTimes(1);
    expect(getProfilePicUrl).toHaveBeenCalledWith(GROUP);
  });

  it('stays a refusal for an admin while WhatsApp still holds a picture the page did not know of', async () => {
    const { adapter } = setup(undefined, admin, true, 'https://pps.whatsapp.net/v/picture.jpg');

    const attempt = adapter.deleteGroupPicture(GROUP);
    await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
    await expect(attempt).rejects.toThrow(/did not attempt it/);
  });

  it('answers a retryable failure, not a success, when WhatsApp Web does not say in time whether one is left', async () => {
    const timeout = new Error(
      "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
    );
    const { adapter } = setup(undefined, admin, true, timeout);

    await expect(adapter.deleteGroupPicture(GROUP)).rejects.toBeInstanceOf(EngineTransportError);
  });

  it.each([
    ['a member of a group whose info only admins may edit', member, true],
    ['a member of a group that does not say whether its info is locked', member, undefined],
    ['an account the participant list does not name', null, false],
  ])('stays a refusal for %s, and names both causes', async (_who, self, restrict) => {
    const { adapter, getProfilePicUrl } = setup(undefined, self, restrict);

    const attempt = adapter.deleteGroupPicture(GROUP);
    await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
    await expect(attempt).rejects.toThrow(/did not attempt it, as when the group has no picture or admin rights/);
    expect(getProfilePicUrl).not.toHaveBeenCalled();
  });

  it('is a refusal for an admin too when WhatsApp answers false', async () => {
    const { adapter } = setup(false, admin, true);

    const attempt = adapter.deleteGroupPicture(GROUP);
    await expect(attempt).rejects.toBeInstanceOf(EngineRefusedError);
    await expect(attempt).rejects.toThrow(/admin rights required/);
  });

  it('succeeds when WhatsApp removed the picture', async () => {
    const { adapter } = setup(true, member, true);

    await expect(adapter.deleteGroupPicture(GROUP)).resolves.toBeUndefined();
  });
});
