import { describe, expect, it } from 'vitest';
import { OpenWAClient } from '../src';
import { MockTransport } from './helpers';

function client(t: MockTransport): OpenWAClient {
  return new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: t.asFetch() });
}

describe('MessagesResource — exact paths', () => {
  it('sendText posts to /messages/send-text (NOT /messages/text)', async () => {
    const t = new MockTransport().on('POST', /send-text$/, { body: { messageId: 'm1', timestamp: 1 } });
    await client(t).messages.sendText('s1', { chatId: 'a@c.us', text: 'hi' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1/messages/send-text');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', text: 'hi' });
  });

  it('sendText forwards mentions verbatim', async () => {
    const t = new MockTransport().on('POST', /send-text$/, { body: { messageId: 'm1', timestamp: 1 } });
    await client(t).messages.sendText('s1', { chatId: 'g@g.us', text: 'hi @628123', mentions: ['628123@c.us'] });
    expect(t.lastCall!.body).toEqual({ chatId: 'g@g.us', text: 'hi @628123', mentions: ['628123@c.us'] });
  });

  it('sendPoll posts to /messages/send-poll', async () => {
    const t = new MockTransport().on('POST', /send-poll$/, { body: { messageId: 'm2', timestamp: 2 } });
    const res = await client(t).messages.sendPoll('s1', {
      chatId: 'a@c.us',
      name: 'Where?',
      options: ['Park', 'Beach'],
      allowMultipleAnswers: true,
    });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1/messages/send-poll');
    expect(t.lastCall!.body).toEqual({
      chatId: 'a@c.us',
      name: 'Where?',
      options: ['Park', 'Beach'],
      allowMultipleAnswers: true,
    });
    expect(res.messageId).toBe('m2');
  });

  it('sendImage posts to /messages/send-image', async () => {
    const t = new MockTransport().on('POST', /send-image$/, { body: { messageId: 'm', timestamp: 2 } });
    await client(t).messages.sendImage('s', { chatId: 'a@c.us', url: 'http://img' });
    expect(t.lastCall!.url).toContain('/messages/send-image');
  });

  it('sendVideo / sendAudio / sendDocument / sendSticker use correct segments', async () => {
    const cases: Array<[string, (c: OpenWAClient) => Promise<unknown>]> = [
      ['send-video', c => c.messages.sendVideo('s', { chatId: 'a@c.us', url: 'u' })],
      ['send-audio', c => c.messages.sendAudio('s', { chatId: 'a@c.us', url: 'u' })],
      ['send-document', c => c.messages.sendDocument('s', { chatId: 'a@c.us', filename: 'f.pdf' })],
      ['send-sticker', c => c.messages.sendSticker('s', { chatId: 'a@c.us', url: 'u' })],
    ];
    for (const [segment, fn] of cases) {
      const t = new MockTransport().on('POST', new RegExp(`${segment}$`), { body: { messageId: 'm', timestamp: 3 } });
      await fn(client(t));
      expect(t.lastCall!.url).toContain(`/messages/${segment}`);
    }
  });

  it('sendLocation / sendContact / sendTemplate', async () => {
    const t = new MockTransport()
      .on('POST', /send-location/, { body: { messageId: 'm', timestamp: 1 } })
      .on('POST', /send-contact/, { body: { messageId: 'm', timestamp: 1 } })
      .on('POST', /send-template/, { body: { messageId: 'm', timestamp: 1 } });
    const c = client(t);
    await c.messages.sendLocation('s', { chatId: 'a@c.us', latitude: -6.2, longitude: 106.8 });
    expect(t.lastCall!.url).toContain('/messages/send-location');
    await c.messages.sendContact('s', { chatId: 'a@c.us', contactName: 'A', contactNumber: '628' });
    expect(t.lastCall!.url).toContain('/messages/send-contact');
    await c.messages.sendTemplate('s', { chatId: 'a@c.us', templateId: 't1', vars: { name: 'Sam' } });
    expect(t.lastCall!.url).toContain('/messages/send-template');
    // Server DTO field is `vars` (NOT `variables`) — body must forward verbatim.
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', templateId: 't1', vars: { name: 'Sam' } });
  });

  it('sendTemplate accepts templateName as the alternative to templateId', async () => {
    const t = new MockTransport().on('POST', /send-template/, { body: { messageId: 'm', timestamp: 1 } });
    await client(t).messages.sendTemplate('s', { chatId: 'a@c.us', templateName: 'welcome', vars: { x: '1' } });
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', templateName: 'welcome', vars: { x: '1' } });
  });

  it('list returns the {messages,total} wrapper the server actually sends', async () => {
    const t = new MockTransport().on('GET', /\/messages$/, {
      body: {
        messages: [
          {
            id: '1',
            sessionId: 's',
            chatId: 'a@c.us',
            from: 'a@c.us',
            to: 's',
            type: 'text',
            direction: 'incoming',
            status: 'delivered',
            createdAt: '',
          },
        ],
        total: 1,
      },
    });
    const res = await client(t).messages.list('s', { chatId: 'a@c.us' });
    expect(res.total).toBe(1);
    expect(res.messages).toHaveLength(1);
  });

  // Asserted on the BODY, not the URL: the field is what this is about, and a URL assertion cannot
  // see a dropped key. One case per request type, because each is a separate declaration — a type
  // that forgot the field would still send it from JS but would not compile for a typed caller.
  it.each([
    [
      'send-text',
      (c: OpenWAClient) => c.messages.sendText('s1', { chatId: 'a@c.us', text: 'hi', quotedMessageId: 'q1' }),
    ],
    [
      'send-image',
      (c: OpenWAClient) => c.messages.sendImage('s1', { chatId: 'a@c.us', url: 'http://u', quotedMessageId: 'q1' }),
    ],
    [
      'send-location',
      (c: OpenWAClient) =>
        c.messages.sendLocation('s1', { chatId: 'a@c.us', latitude: 1, longitude: 2, quotedMessageId: 'q1' }),
    ],
    [
      'send-contact',
      (c: OpenWAClient) =>
        c.messages.sendContact('s1', {
          chatId: 'a@c.us',
          contactName: 'A',
          contactNumber: '628',
          quotedMessageId: 'q1',
        }),
    ],
    [
      'send-poll',
      (c: OpenWAClient) =>
        c.messages.sendPoll('s1', { chatId: 'a@c.us', name: 'Q', options: ['a', 'b'], quotedMessageId: 'q1' }),
    ],
  ])('%s forwards quotedMessageId in the body', async (route, call) => {
    const t = new MockTransport().on('POST', new RegExp(`${route}$`), { body: { messageId: 'm', timestamp: 1 } });
    await call(client(t));
    expect(t.lastCall!.body).toMatchObject({ quotedMessageId: 'q1' });
  });

  // Known-negative control: an ordinary send must not carry the key at all, so an implementation
  // that always emitted it (as `undefined`, which JSON.stringify drops but a proxy may not) fails.
  it('omits quotedMessageId entirely on an ordinary send', async () => {
    const t = new MockTransport().on('POST', /send-image$/, { body: { messageId: 'm', timestamp: 1 } });
    await client(t).messages.sendImage('s1', { chatId: 'a@c.us', url: 'http://u' });
    expect(t.lastCall!.body).not.toHaveProperty('quotedMessageId');
  });

  it('reply / forward / react / delete', async () => {
    const t = new MockTransport()
      .on('POST', /\/messages\/reply$/, { body: { messageId: 'm', timestamp: 1 } })
      .on('POST', /\/messages\/forward$/, { body: { messageId: 'm', timestamp: 1 } })
      .on('POST', /\/messages\/react$/, { body: { success: true } })
      .on('POST', /\/messages\/delete$/, { body: { success: true } });
    const c = client(t);
    await c.messages.reply('s', { chatId: 'a@c.us', quotedMessageId: 'q', text: 'r' });
    expect(t.lastCall!.url).toContain('/messages/reply');
    await c.messages.forward('s', { fromChatId: 'a@c.us', toChatId: 'b@c.us', messageId: 'm' });
    expect(t.lastCall!.url).toContain('/messages/forward');
    await c.messages.react('s', { chatId: 'a@c.us', messageId: 'm', emoji: '👍' });
    expect(t.lastCall!.url).toContain('/messages/react');
    await c.messages.delete('s', { chatId: 'a@c.us', messageId: 'm' });
    expect(t.lastCall!.url).toContain('/messages/delete');
  });

  it('clickButton posts to /messages/click-button', async () => {
    const t = new MockTransport().on('POST', /\/messages\/click-button$/, {
      body: { messageId: 'm2', timestamp: 9 },
    });
    const res = await client(t).messages.clickButton('s', {
      chatId: 'a@c.us',
      messageId: 'prompt1',
      buttonId: 'yes',
      text: 'Sim',
    });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/click-button');
    expect(t.lastCall!.body).toEqual({
      chatId: 'a@c.us',
      messageId: 'prompt1',
      buttonId: 'yes',
      text: 'Sim',
    });
    expect(res.messageId).toBe('m2');
  });

  it('editMessage posts to /messages/edit and returns the MessageResponse shape', async () => {
    const t = new MockTransport().on('POST', /\/messages\/edit$/, { body: { messageId: 'm1', timestamp: 4 } });
    const res = await client(t).messages.editMessage('s', { chatId: 'a@c.us', messageId: 'm1', body: 'edited' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/messages/edit');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', messageId: 'm1', body: 'edited' });
    expect(res.messageId).toBe('m1');
    expect(res.timestamp).toBe(4);
  });

  it('history puts chatId in the path', async () => {
    const t = new MockTransport().on('GET', /\/messages\/[^/]+\/history$/, { body: [] });
    await client(t).messages.history('s', 'a@c.us', { limit: 5 });
    expect(t.lastCall!.url).toContain('/messages/a@c.us/history');
    expect(t.lastCall!.url).toContain('limit=5');
  });

  it('reactions puts chatId and messageId in the path', async () => {
    const t = new MockTransport().on('GET', /\/reactions$/, { body: [] });
    await client(t).messages.reactions('s', 'a@c.us', 'm1');
    expect(t.lastCall!.url).toContain('/a@c.us/m1/reactions');
  });

  it('sendBulk + batchStatus + cancelBatch', async () => {
    const t = new MockTransport()
      .on('POST', /send-bulk$/, {
        body: { batchId: 'b', status: 'queued', totalMessages: 1, estimatedCompletionTime: 't', statusUrl: '/u' },
      })
      .on('GET', /\/batch\/b$/, {
        body: {
          batchId: 'b',
          status: 'done',
          progress: { total: 1, sent: 1, failed: 0, pending: 0, cancelled: 0 },
          results: [],
          startedAt: 's',
          completedAt: 'c',
        },
      })
      .on('POST', /\/batch\/b\/cancel$/, {
        body: {
          batchId: 'b',
          status: 'cancelled',
          progress: { total: 1, sent: 0, failed: 0, pending: 0, cancelled: 1 },
        },
      });
    const c = client(t);
    await c.messages.sendBulk('s', { messages: [{ chatId: 'a@c.us', type: 'text', content: { text: 'x' } }] });
    expect(t.lastCall!.url).toContain('/messages/send-bulk');
    const status = await c.messages.batchStatus('s', 'b');
    expect(status.progress?.sent).toBe(1);
    expect(t.lastCall!.url).toContain('/messages/batch/b');
    const cancelled = await c.messages.cancelBatch('s', 'b');
    expect(cancelled.status).toBe('cancelled');
    expect(t.lastCall!.url).toContain('/messages/batch/b/cancel');
    expect(t.lastCall!.method).toBe('POST');
  });
});
