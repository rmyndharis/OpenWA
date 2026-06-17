import { OpenWaChatGateway } from './openwa-chat.gateway';

describe('OpenWaChatGateway', () => {
  function deps(engine: unknown) {
    const messageService = {
      sendText: jest.fn().mockResolvedValue({ messageId: 'x', timestamp: 1 }),
      reply: jest.fn().mockResolvedValue({ messageId: 'y', timestamp: 1 }),
    };
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) };
    return { messageService, sessionService };
  }

  it('sendText delegates to MessageService.sendText', async () => {
    const { messageService, sessionService } = deps({});
    const gw = new OpenWaChatGateway(messageService as never, sessionService as never);
    await gw.sendText('s', 'c@g.us', 'hi');
    expect(messageService.sendText).toHaveBeenCalledWith('s', { chatId: 'c@g.us', text: 'hi' });
  });

  it('sendCombinedReply delegates to MessageService.reply', async () => {
    const { messageService, sessionService } = deps({});
    const gw = new OpenWaChatGateway(messageService as never, sessionService as never);
    await gw.sendCombinedReply('s', 'c@g.us', 'M1', 'Hola');
    expect(messageService.reply).toHaveBeenCalledWith('s', { chatId: 'c@g.us', quotedMessageId: 'M1', text: 'Hola' });
  });

  it('getGroupAdmins returns admin/superadmin WIDs from the engine', async () => {
    const engine = {
      getGroupInfo: jest.fn().mockResolvedValue({
        participants: [
          { id: '111@c.us', isAdmin: true, isSuperAdmin: false },
          { id: '222@c.us', isAdmin: false, isSuperAdmin: true },
          { id: '333@c.us', isAdmin: false, isSuperAdmin: false },
        ],
      }),
    };
    const { messageService, sessionService } = deps(engine);
    const gw = new OpenWaChatGateway(messageService as never, sessionService as never);
    expect(await gw.getGroupAdmins('s', 'c@g.us')).toEqual(['111@c.us', '222@c.us']);
  });

  it('getGroupAdmins includes the group owner (LID scheme) alongside phone-scheme admins', async () => {
    const engine = {
      getGroupInfo: jest.fn().mockResolvedValue({
        owner: '149207180681386@lid',
        participants: [
          { id: '19729002902@c.us', isAdmin: true, isSuperAdmin: true },
          { id: '573133889572@c.us', isAdmin: false, isSuperAdmin: false },
        ],
      }),
    };
    const { messageService, sessionService } = deps(engine);
    const gw = new OpenWaChatGateway(messageService as never, sessionService as never);
    const admins = await gw.getGroupAdmins('s', 'c@g.us');
    expect(admins).toContain('19729002902@c.us'); // admin participant (phone scheme)
    expect(admins).toContain('149207180681386@lid'); // owner (LID scheme — matches message authors)
  });

  it('getGroupAdmins returns [] when the session has no engine', async () => {
    const { messageService, sessionService } = deps(undefined);
    const gw = new OpenWaChatGateway(messageService as never, sessionService as never);
    expect(await gw.getGroupAdmins('s', 'c@g.us')).toEqual([]);
  });
});
