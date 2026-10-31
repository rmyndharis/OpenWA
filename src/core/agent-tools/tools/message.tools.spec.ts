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
    expect(getChatHistory).toHaveBeenCalledWith('s1', '628111@c.us', 50, true, true, undefined);
    expect(out).toEqual([{ id: 'm1' }]);
  });

  it('MessageHistory hands the request cancellation signal to getChatHistory', async () => {
    const getChatHistory = jest.fn().mockResolvedValue([]);
    const tools = makeTools({ getChatHistory } as unknown as MessageService);
    const controller = new AbortController();
    await invokeTool(
      tools.get('MessageHistory')!,
      { sessionId: 's1', chatId: '628111@c.us' },
      'key',
      makeAuth() as unknown as AuthService,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    expect((getChatHistory.mock.calls[0] as unknown[])[5]).toBe(controller.signal);
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

  it('forwards a tag list on the text and reply tools', async () => {
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const reply = jest.fn().mockResolvedValue({ id: 'm2' });
    const tools = makeTools({ sendText, reply } as unknown as MessageService);

    await run(tools.get('MessageSendText')!, {
      sessionId: 's1',
      chatId: '120363@g.us',
      text: 'hi @62811',
      mentions: ['62811@c.us'],
    });
    expect(sendText).toHaveBeenCalledWith('s1', expect.objectContaining({ mentions: ['62811@c.us'] }));

    await run(tools.get('MessageReply')!, {
      sessionId: 's1',
      chatId: '120363@g.us',
      quotedMessageId: 'm1',
      text: 'hi @62811',
      mentions: ['62811@c.us'],
    });
    expect(reply).toHaveBeenCalledWith('s1', expect.objectContaining({ mentions: ['62811@c.us'] }));
  });

  it('refuses a tag that is not an individual WID, instead of dropping it', async () => {
    // The whole point of declaring the field here. A tool schema is a plain z.object, so before it was
    // declared an agent's `mentions` was stripped silently and the send reported success; and this path
    // calls the service directly, so no ValidationPipe ever sees the value.
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendText } as unknown as MessageService);

    // The detail lives on the response, not on .message, which reads "Bad Request Exception".
    await expect(
      run(tools.get('MessageSendText')!, {
        sessionId: 's1',
        chatId: '120363@g.us',
        text: 'hi',
        mentions: ['120363000000000000@g.us'],
      }),
    ).rejects.toMatchObject({
      response: { message: [expect.stringContaining('individual WID') as unknown as string] },
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    ['MessageSendText', { text: 'hi' }],
    ['MessageSendLocation', { latitude: 1, longitude: 2 }],
    ['MessageReact', { messageId: 'm1', emoji: '👍' }],
  ])('%s refuses a chat id that is no JID before the service sees it', async (name, rest) => {
    // The tool calls the service directly, so no ValidationPipe holds the rule for it; an id the engine
    // cannot decode otherwise ends as a 500 and counts against the session's send breaker.
    const service = { sendText: jest.fn(), sendLocation: jest.fn(), reactToMessage: jest.fn() };
    const tools = makeTools(service as unknown as MessageService);

    await expect(run(tools.get(name)!, { sessionId: 's1', chatId: '6281270008896', ...rest })).rejects.toMatchObject({
      response: { message: [expect.stringContaining('localpart@host') as unknown as string] },
    });
    expect(service.sendText).not.toHaveBeenCalled();
    expect(service.sendLocation).not.toHaveBeenCalled();
    expect(service.reactToMessage).not.toHaveBeenCalled();
  });

  it('forwards a caller-supplied link preview, and enforces the title WhatsApp requires', async () => {
    // REST declares customLinkPreview; the tool did not, so an agent's object was stripped before the
    // handler ran and the send went out with whatever preview the engine chose on its own.
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendText } as unknown as MessageService);

    await run(tools.get('MessageSendText')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      text: 'see https://example.com/launch',
      customLinkPreview: { url: 'https://example.com/launch', title: 'We just launched' },
    });
    expect(sendText).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        customLinkPreview: { url: 'https://example.com/launch', title: 'We just launched' },
      }),
    );

    // Control: the required title is enforced here, not left to the DTO, because this path never
    // reaches the ValidationPipe.
    sendText.mockClear();
    await expect(
      run(tools.get('MessageSendText')!, {
        sessionId: 's1',
        chatId: '628111@c.us',
        text: 'see https://example.com/launch',
        customLinkPreview: { url: 'https://example.com/launch' },
      }),
    ).rejects.toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('forwards a preview image, and refuses an image URL that is not http(s)', async () => {
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendText } as unknown as MessageService);
    const preview = { url: 'https://example.com/launch', title: 'We just launched' };

    await run(tools.get('MessageSendText')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      text: 'see https://example.com/launch',
      customLinkPreview: { ...preview, thumbnailUrl: 'https://cdn.example/a.jpg' },
    });
    expect(sendText).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ customLinkPreview: { ...preview, thumbnailUrl: 'https://cdn.example/a.jpg' } }),
    );

    sendText.mockClear();
    await expect(
      run(tools.get('MessageSendText')!, {
        sessionId: 's1',
        chatId: '628111@c.us',
        text: 'see https://example.com/launch',
        customLinkPreview: { ...preview, thumbnailUrl: 'file:///etc/passwd' },
      }),
    ).rejects.toBeDefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('tags a sticker too, now that both adapters carry the list', async () => {
    // Excluded when this tool set was written, because neither adapter built a mention list for a
    // sticker. Both do now, and the route has always accepted the field, so withholding it here
    // would leave the MCP surface silently weaker than REST for the same send.
    const sendSticker = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendSticker } as unknown as MessageService);

    await run(tools.get('MessageSendSticker')!, {
      sessionId: 's1',
      chatId: '120363@g.us',
      url: 'https://example.test/s.webp',
      mentions: ['62811@c.us'],
    });

    expect(sendSticker).toHaveBeenCalledWith('s1', expect.objectContaining({ mentions: ['62811@c.us'] }));
  });

  it('rejects a media url that is not http(s)', async () => {
    // Both engines decode a non-http(s) string as base64, so an ftp:// URL would send garbage bytes.
    const sendImage = jest.fn().mockResolvedValue({ id: 'm1' });
    const tools = makeTools({ sendImage } as unknown as MessageService);

    await expect(
      run(tools.get('MessageSendImage')!, { sessionId: 's1', chatId: '628111@c.us', url: 'ftp://example.com/a.jpg' }),
    ).rejects.toMatchObject({
      response: { message: [expect.stringContaining('http(s)') as unknown as string] },
    });
    expect(sendImage).not.toHaveBeenCalled();

    await run(tools.get('MessageSendImage')!, {
      sessionId: 's1',
      chatId: '628111@c.us',
      url: 'http://media_server:8080/a.jpg',
    });
    expect(sendImage).toHaveBeenCalledWith('s1', expect.objectContaining({ url: 'http://media_server:8080/a.jpg' }));
  });

  describe.each([
    ['MessageSendImage', 'sendImage'],
    ['MessageSendVideo', 'sendVideo'],
    ['MessageSendAudio', 'sendAudio'],
    ['MessageSendDocument', 'sendDocument'],
    ['MessageSendSticker', 'sendSticker'],
  ])('%s url next to base64', (toolName, method) => {
    const call = (extra: Record<string, unknown>) => {
      const send = jest.fn().mockResolvedValue({ id: 'm1' });
      const tools = makeTools({ [method]: send } as unknown as MessageService);
      const result = run(tools.get(toolName)!, { sessionId: 's1', chatId: '628111@c.us', ...extra });
      return { send, result };
    };

    it.each([
      ['an empty url', ''],
      ['a url that is not http(s)', 'ftp://example.com/a.bin'],
    ])('sends the base64 and ignores %s, as the REST route does', async (_label, url) => {
      const { send, result } = call({ url, base64: 'QUJD', mimetype: 'application/octet-stream' });
      await result;
      expect(send).toHaveBeenCalledWith('s1', expect.objectContaining({ url, base64: 'QUJD' }));
    });

    it.each([
      ['no base64', undefined],
      ['an empty base64', ''],
      ['a base64 that is only a data-URI prefix', 'data:image/png;base64,'],
    ])('still rejects a url that is not http(s) next to %s', async (_label, base64) => {
      const { send, result } = call({ url: 'ftp://example.com/a.bin', base64 });
      await expect(result).rejects.toMatchObject({
        response: { message: [expect.stringContaining('url: ') as unknown as string] },
      });
      expect(send).not.toHaveBeenCalled();
    });
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
