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
          { id: '1', sessionId: 's', chatId: 'a@c.us', from: 'a@c.us', to: 's', type: 'text', direction: 'incoming', status: 'delivered', createdAt: '' },
        ],
        total: 1,
      },
    });
    const res = await client(t).messages.list('s', { chatId: 'a@c.us' });
    expect(res.total).toBe(1);
    expect(res.messages).toHaveLength(1);
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
        body: { batchId: 'b', status: 'cancelled', progress: { total: 1, sent: 0, failed: 0, pending: 0, cancelled: 1 } },
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
