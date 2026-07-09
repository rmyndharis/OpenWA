import { describe, expect, it } from 'vitest';
import { OpenWAClient } from '../src';
import { MockTransport } from './helpers';

function client(t: MockTransport): OpenWAClient {
  return new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: t.asFetch() });
}

describe('GroupsResource — exact paths and bodies', () => {
  it('list / get / create', async () => {
    const t = new MockTransport()
      .on('GET', /\/groups$/, { body: [] })
      .on('GET', /\/groups\/g1@g\.us$/, { body: { id: 'g1@g.us', name: 'G', participants: [] } })
      .on('POST', /\/groups$/, { body: { id: 'g1@g.us', name: 'G', participants: [] } });
    const c = client(t);
    await c.groups.list('s');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups');
    await c.groups.get('s', 'g1@g.us');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s/groups/g1@g.us');
    await c.groups.create('s', { name: 'G', participants: ['a@c.us'] });
    expect(t.lastCall!.body).toEqual({ name: 'G', participants: ['a@c.us'] });
  });

  it('participant ops wrap participants in a body', async () => {
    const t = new MockTransport()
      .on('POST', /\/participants$/, { body: { success: true, message: 'added' } })
      .on('DELETE', /\/participants$/, { body: { success: true } })
      .on('POST', /\/participants\/promote$/, { body: { success: true } })
      .on('POST', /\/participants\/demote$/, { body: { success: true } });
    const c = client(t);
    await c.groups.addParticipants('s', 'g1@g.us', ['a@c.us', 'b@c.us']);
    expect(t.lastCall!.body).toEqual({ participants: ['a@c.us', 'b@c.us'] });
    expect(t.lastCall!.method).toBe('POST');
    await c.groups.removeParticipants('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.method).toBe('DELETE');
    await c.groups.promoteParticipants('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.url).toContain('/participants/promote');
    await c.groups.demoteParticipants('s', 'g1@g.us', ['a@c.us']);
    expect(t.lastCall!.url).toContain('/participants/demote');
  });

  it('subject / description / leave / inviteCode / revoke', async () => {
    const t = new MockTransport()
      .on('PUT', /\/subject$/, { body: { success: true } })
      .on('PUT', /\/description$/, { body: { success: true } })
      .on('POST', /\/leave$/, { body: { success: true } })
      .on('GET', /\/invite-code$/, { body: { inviteCode: 'c', inviteLink: 'l' } })
      .on('POST', /\/invite-code\/revoke$/, { body: { inviteCode: 'c2', inviteLink: 'l2' } });
    const c = client(t);
    await c.groups.setSubject('s', 'g', 'New');
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.body).toEqual({ subject: 'New' });
    await c.groups.setDescription('s', 'g', 'desc');
    expect(t.lastCall!.body).toEqual({ description: 'desc' });
    await c.groups.leave('s', 'g');
    await c.groups.inviteCode('s', 'g');
    await c.groups.revokeInviteCode('s', 'g');
    expect(t.lastCall!.url).toContain('/invite-code/revoke');
  });
});

describe('ContactsResource — exact paths', () => {
  it('list / get / check / profilePicture / phone', async () => {
    const t = new MockTransport()
      .on('GET', /\/contacts$/, { body: [] })
      .on('GET', /\/contacts\/[^/]+$/, { body: { id: 'a@c.us' } })
      .on('GET', /\/check\/628123$/, { body: { number: '628123', exists: true, whatsappId: '628123@c.us' } })
      .on('GET', /\/profile-picture$/, { body: { url: 'http://p' } })
      .on('GET', /\/phone$/, { body: { contactId: 'x@lid', phone: '628123' } });
    const c = client(t);
    await c.contacts.list('s', { limit: 10 });
    expect(t.lastCall!.url).toContain('limit=10');
    await c.contacts.get('s', 'a@c.us');
    await c.contacts.check('s', '628123');
    expect(t.lastCall!.url).toContain('/check/628123');
    await c.contacts.profilePicture('s', 'a@c.us');
    await c.contacts.phone('s', 'x@lid');
  });

  it('block (POST) / unblock (DELETE)', async () => {
    const t = new MockTransport()
      .on('POST', /\/block$/, { body: { success: true } })
      .on('DELETE', /\/block$/, { body: { success: true } });
    const c = client(t);
    await c.contacts.block('s', 'a@c.us');
    expect(t.lastCall!.method).toBe('POST');
    await c.contacts.unblock('s', 'a@c.us');
    expect(t.lastCall!.method).toBe('DELETE');
  });
});

describe('WebhooksResource — exact paths', () => {
  it('list/get/create/update/delete/test', async () => {
    const t = new MockTransport()
      .on('GET', /\/webhooks$/, { body: [] })
      .on('GET', /\/webhooks\/w1$/, {
        body: { id: 'w1', sessionId: 's', url: 'u', events: ['*'], active: true, createdAt: '', updatedAt: '' },
      })
      .on('POST', /\/webhooks$/, {
        body: { id: 'w1', sessionId: 's', url: 'u', events: ['*'], active: true, retryCount: 5, lastTriggeredAt: null, createdAt: '', updatedAt: '' },
      })
      .on('PUT', /\/webhooks\/w1$/, {
        body: { id: 'w1', sessionId: 's', url: 'u', events: ['*'], active: false, createdAt: '', updatedAt: '' },
      })
      .on('DELETE', /\/webhooks\/w1$/, { status: 204 })
      .on('POST', /\/webhooks\/w1\/test$/, { body: { success: true } });
    const c = client(t);
    await c.webhooks.list('s');
    await c.webhooks.get('s', 'w1');
    // Server DTO field is `retryCount` (NOT `retries`) — body must forward verbatim.
    const created = await c.webhooks.create('s', { url: 'u', events: ['*'], retryCount: 5 });
    expect(t.lastCall!.body).toEqual({ url: 'u', events: ['*'], retryCount: 5 });
    // Response exposes retryCount and lastTriggeredAt; secret/headers are stripped server-side.
    expect(created.retryCount).toBe(5);
    expect(created.lastTriggeredAt).toBeNull();
    await c.webhooks.update('s', 'w1', { active: false });
    expect(t.lastCall!.method).toBe('PUT');
    await c.webhooks.delete('s', 'w1');
    await c.webhooks.test('s', 'w1');
    expect(t.lastCall!.url).toContain('/webhooks/w1/test');
  });
});

describe('StatusResource — nested media bodies', () => {
  it('sendImage/sendVideo forward the server-required nested {image|video:{...}} shape', async () => {
    const t = new MockTransport()
      .on('POST', /\/status\/send-image$/, { body: { statusId: 's1', timestamp: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' } })
      .on('POST', /\/status\/send-video$/, { body: { statusId: 's2', timestamp: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-02T00:00:00.000Z' } });
    const c = client(t);
    await c.status.sendImage('s', { image: { url: 'http://img' }, recipients: ['a@c.us'], caption: 'hi' });
    expect(t.lastCall!.body).toEqual({ image: { url: 'http://img' }, recipients: ['a@c.us'], caption: 'hi' });
    await c.status.sendVideo('s', { video: { url: 'http://vid' }, recipients: ['a@c.us'] });
    expect(t.lastCall!.body).toEqual({ video: { url: 'http://vid' }, recipients: ['a@c.us'] });
  });
});

describe('ChatsResource — exact paths', () => {
  it('list / markRead / markUnread / delete / sendState', async () => {
    const t = new MockTransport()
      .on('GET', /\/chats$/, { body: [] })
      .on('POST', /\/chats\/read$/, { body: { success: true } })
      .on('POST', /\/chats\/unread$/, { body: { success: true } })
      .on('POST', /\/chats\/delete$/, { body: { success: true } })
      .on('POST', /\/chats\/typing$/, { body: { success: true } });
    const c = client(t);
    await c.chats.list('s');
    await c.chats.markRead('s', { chatId: 'a@c.us' });
    expect(t.lastCall!.url).toContain('/chats/read');
    await c.chats.markUnread('s', { chatId: 'a@c.us' });
    await c.chats.delete('s', { chatId: 'a@c.us' });
    await c.chats.sendState('s', { chatId: 'a@c.us', state: 'typing' });
    expect(t.lastCall!.url).toContain('/chats/typing');
  });
});

describe('HealthResource + auth — exact paths', () => {
  it('health/live/ready and auth validate', async () => {
    const t = new MockTransport()
      .on('GET', /\/health$/, { body: { status: 'ok', version: '0.7.2' } })
      .on('GET', /\/health\/live$/, { body: { status: 'ok' } })
      .on('GET', /\/health\/ready$/, { body: { status: 'ok', details: {} } })
      .on('POST', /\/auth\/validate$/, { body: { valid: true, role: 'admin' } });
    const c = client(t);
    await c.health.check();
    expect(t.lastCall!.url).toBe('http://x/api/health');
    await c.health.live();
    await c.health.ready();
    await c.auth();
    expect(t.lastCall!.method).toBe('POST');
    expect(t.lastCall!.url).toBe('http://x/api/auth/validate');
  });
});

describe('SearchResource — exact path and query forwarding', () => {
  it('forwards params as a query string to /api/search', async () => {
    const t = new MockTransport().on('GET', /\/search$/, {
      body: { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' },
    });
    const c = client(t);
    const res = await c.search.search({ q: 'hello', sessionId: 's1', limit: 10, offset: 0 });
    expect(t.lastCall!.method).toBe('GET');
    expect(t.lastCall!.url).toBe('http://x/api/search?q=hello&sessionId=s1&limit=10&offset=0');
    expect(res.provider).toBe('builtin-fts');
    expect(res.total).toBe(0);
  });

  it('omits undefined optional filters from the query string', async () => {
    const t = new MockTransport().on('GET', /\/search$/, {
      body: { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' },
    });
    const c = client(t);
    await c.search.search({ q: 'term', chatId: '628@c.us', direction: 'incoming' });
    expect(t.lastCall!.url).toBe('http://x/api/search?q=term&chatId=628%40c.us&direction=incoming');
  });
});
