import { invokeTool } from '../tool-invoker';
import { messageTools } from './message.tools';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { MessageService } from '../../../modules/message/message.service';
import type { AuthService } from '../../../modules/auth/auth.service';

// Covers every messageTools execute() handler via the real invokeTool path (auth → zod → handler).
// agent-tools.module.ts is pure Nest wiring, stays at 0% coverage, and is intentionally not a target.

function makeAuth(): Pick<AuthService, 'validateApiKey' | 'hasPermission'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
    hasPermission: jest.fn().mockReturnValue(true),
  };
}

function makeTools(svc: MessageService): Map<string, AnyToolDescriptor> {
  return new Map(messageTools(svc).map(t => [t.name, t]));
}

async function run(tool: AnyToolDescriptor, input: unknown): Promise<unknown> {
  return invokeTool(tool, input, 'key', makeAuth() as unknown as AuthService);
}

describe('messageTools', () => {
  it('MessageList delegates to getMessages with the filter fields', async () => {
    const getMessages = jest.fn().mockResolvedValue([{ id: 'm1' }]);
    const tools = makeTools({ getMessages } as unknown as MessageService);
    const out = await run(tools.get('MessageList')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      limit: 10,
      offset: 5,
    });
    expect(getMessages).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      from: undefined,
      limit: 10,
      offset: 5,
    });
    expect(out).toEqual([{ id: 'm1' }]);
  });

  it('MessageHistory delegates to getChatHistory', async () => {
    const getChatHistory = jest.fn().mockResolvedValue([{ id: 'm1' }]);
    const tools = makeTools({ getChatHistory } as unknown as MessageService);
    const out = await run(tools.get('MessageHistory')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      limit: 50,
      includeMedia: true,
      deep: true,
    });
    expect(getChatHistory).toHaveBeenCalledWith('s1', '628111@c.us', 50, true, true);
    expect(out).toEqual([{ id: 'm1' }]);
  });

  it('MessageGetReactions delegates to getMessageReactions', async () => {
    const getMessageReactions = jest.fn().mockResolvedValue([{ emoji: '👍' }]);
    const tools = makeTools({ getMessageReactions } as unknown as MessageService);
    const out = await run(tools.get('MessageGetReactions')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      messageId: 'm1',
    });
    expect(getMessageReactions).toHaveBeenCalledWith('s1', '628111@c.us', 'm1');
    expect(out).toEqual([{ emoji: '👍' }]);
  });

  it('MessageSendText delegates to sendText and forwards linkPreview when set', async () => {
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendText } as unknown as MessageService);
    const out = await run(tools.get('MessageSendText')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      text: 'hello',
      linkPreview: false,
    });
    expect(sendText).toHaveBeenCalledWith('s1', { chatId: '628111@c.us', text: 'hello', linkPreview: false });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendText omits linkPreview when unset', async () => {
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendText } as unknown as MessageService);
    await run(tools.get('MessageSendText')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      text: 'hello',
    });
    expect(sendText).toHaveBeenCalledWith('s1', { chatId: '628111@c.us', text: 'hello' });
  });

  it('MessageSendImage delegates to sendImage with the media fields', async () => {
    const sendImage = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendImage } as unknown as MessageService);
    const out = await run(tools.get('MessageSendImage')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      url: 'https://example.com/pic.jpg',
      filename: 'pic.jpg',
      caption: 'look',
    });
    expect(sendImage).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      url: 'https://example.com/pic.jpg',
      base64: undefined,
      mimetype: undefined,
      filename: 'pic.jpg',
      caption: 'look',
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendVideo delegates to sendVideo with the media fields', async () => {
    const sendVideo = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendVideo } as unknown as MessageService);
    const out = await run(tools.get('MessageSendVideo')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      url: 'https://example.com/clip.mp4',
      caption: 'watch',
    });
    expect(sendVideo).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      url: 'https://example.com/clip.mp4',
      base64: undefined,
      mimetype: undefined,
      filename: undefined,
      caption: 'watch',
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendAudio delegates to sendAudio including the ptt flag', async () => {
    const sendAudio = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendAudio } as unknown as MessageService);
    const out = await run(tools.get('MessageSendAudio')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      base64: 'QUJD',
      mimetype: 'audio/ogg',
      ptt: true,
    });
    expect(sendAudio).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      url: undefined,
      base64: 'QUJD',
      mimetype: 'audio/ogg',
      filename: undefined,
      caption: undefined,
      ptt: true,
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendDocument delegates to sendDocument with the media fields', async () => {
    const sendDocument = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendDocument } as unknown as MessageService);
    const out = await run(tools.get('MessageSendDocument')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      base64: 'QUJD',
      mimetype: 'application/pdf',
      filename: 'doc.pdf',
    });
    expect(sendDocument).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      url: undefined,
      base64: 'QUJD',
      mimetype: 'application/pdf',
      filename: 'doc.pdf',
      caption: undefined,
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendLocation delegates to sendLocation', async () => {
    const sendLocation = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendLocation } as unknown as MessageService);
    const out = await run(tools.get('MessageSendLocation')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      latitude: -6.2,
      longitude: 106.8,
      description: 'Office',
      address: 'Jl. Sudirman',
    });
    expect(sendLocation).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      latitude: -6.2,
      longitude: 106.8,
      description: 'Office',
      address: 'Jl. Sudirman',
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendContact delegates to sendContact', async () => {
    const sendContact = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendContact } as unknown as MessageService);
    const out = await run(tools.get('MessageSendContact')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      contactName: 'Jane',
      contactNumber: '628222',
    });
    expect(sendContact).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      contactName: 'Jane',
      contactNumber: '628222',
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendSticker delegates to sendSticker with the media fields', async () => {
    const sendSticker = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendSticker } as unknown as MessageService);
    const out = await run(tools.get('MessageSendSticker')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      url: 'https://example.com/sticker.webp',
    });
    expect(sendSticker).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      url: 'https://example.com/sticker.webp',
      base64: undefined,
      mimetype: undefined,
      filename: undefined,
      caption: undefined,
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageSendTemplate delegates to sendTemplate', async () => {
    const sendTemplate = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendTemplate } as unknown as MessageService);
    const out = await run(tools.get('MessageSendTemplate')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      templateName: 'welcome',
      vars: { name: 'Jane' },
    });
    expect(sendTemplate).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      templateId: undefined,
      templateName: 'welcome',
      vars: { name: 'Jane' },
    });
    expect(out).toEqual({ id: 'm1' });
  });

  it('MessageReply delegates to reply', async () => {
    const reply = jest.fn().mockResolvedValue({ id: 'm2' });
    const tools = makeTools({ reply } as unknown as MessageService);
    const out = await run(tools.get('MessageReply')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      quotedMessageId: 'm1',
      text: 'got it',
    });
    expect(reply).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      quotedMessageId: 'm1',
      text: 'got it',
    });
    expect(out).toEqual({ id: 'm2' });
  });

  it('MessageForward delegates to forward', async () => {
    const forward = jest.fn().mockResolvedValue({ id: 'm2' });
    const tools = makeTools({ forward } as unknown as MessageService);
    const out = await run(tools.get('MessageForward')!, {
      sessionId: 's1',
      fromChatId: '628111@c.us',
      toChatId: '628222@c.us',
      messageId: 'm1',
    });
    expect(forward).toHaveBeenCalledWith('s1', {
      fromChatId: '628111@c.us',
      toChatId: '628222@c.us',
      messageId: 'm1',
    });
    expect(out).toEqual({ id: 'm2' });
  });

  it('MessageReact delegates to reactToMessage and maps the void result to success', async () => {
    const reactToMessage = jest.fn().mockResolvedValue(undefined);
    const tools = makeTools({ reactToMessage } as unknown as MessageService);
    const out = (await run(tools.get('MessageReact')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      messageId: 'm1',
      emoji: '👍',
    })) as { success: boolean };
    expect(reactToMessage).toHaveBeenCalledWith('s1', {
      chatId: '628111@c.us',
      messageId: 'm1',
      emoji: '👍',
    });
    expect(out).toEqual({ success: true });
  });
});
