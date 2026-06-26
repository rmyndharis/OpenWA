import { describe, expect, it } from 'vitest';
import { OpenWAClient } from '../src';
import { MockTransport } from './helpers';

function client(t: MockTransport): OpenWAClient {
  return new OpenWAClient({ baseUrl: 'http://localhost:2785', apiKey: 'k', fetch: t.asFetch() });
}

describe('LabelsResource — exact paths', () => {
  it('list / get / forChat / addToChat / removeFromChat', async () => {
    const t = new MockTransport()
      .on('GET', /\/labels$/, { body: [{ id: 'l1', name: 'VIP' }] })
      .on('GET', /\/labels\/l1$/, { body: { id: 'l1', name: 'VIP' } })
      .on('GET', /\/labels\/chat\/a@c\.us$/, { body: [{ id: 'l1', name: 'VIP' }] })
      .on('POST', /\/labels\/chat\/a@c\.us$/, { body: { success: true } })
      .on('DELETE', /\/labels\/chat\/a@c\.us\/l1$/, { body: { success: true } });
    const c = client(t);
    await c.labels.list('s');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/labels');
    await c.labels.get('s', 'l1');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/labels/l1');
    await c.labels.forChat('s', 'a@c.us');
    expect(t.lastCall!.url).toContain('/labels/chat/a@c.us');
    await c.labels.addToChat('s', 'a@c.us', { labelId: 'l1' });
    expect(t.lastCall!.method).toBe('POST');
    expect(t.lastCall!.body).toEqual({ labelId: 'l1' });
    await c.labels.removeFromChat('s', 'a@c.us', 'l1');
    expect(t.lastCall!.method).toBe('DELETE');
    expect(t.lastCall!.url).toContain('/labels/chat/a@c.us/l1');
  });
});

describe('ChannelsResource — exact paths', () => {
  it('list / get / messages / subscribe / unsubscribe', async () => {
    const t = new MockTransport()
      .on('GET', /\/channels$/, { body: [{ id: '123@newsletter', name: 'News' }] })
      .on('GET', /\/channels\/123@newsletter$/, { body: { id: '123@newsletter', name: 'News' } })
      .on('GET', /\/channels\/123@newsletter\/messages$/, { body: [] })
      .on('POST', /\/channels\/subscribe$/, { body: { id: '123@newsletter', name: 'News' } })
      .on('DELETE', /\/channels\/123@newsletter$/, { body: { success: true } });
    const c = client(t);
    await c.channels.list('s');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/channels');
    await c.channels.get('s', '123@newsletter');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/channels/123@newsletter');
    await c.channels.messages('s', '123@newsletter', { limit: 10 });
    expect(t.lastCall!.url).toContain('/channels/123@newsletter/messages');
    expect(t.lastCall!.url).toContain('limit=10');
    await c.channels.subscribe('s', { inviteCode: 'ABCxyz' });
    expect(t.lastCall!.method).toBe('POST');
    expect(t.lastCall!.body).toEqual({ inviteCode: 'ABCxyz' });
    expect(t.lastCall!.url).toContain('/channels/subscribe');
    await c.channels.unsubscribe('s', '123@newsletter');
    expect(t.lastCall!.method).toBe('DELETE');
  });
});

describe('CatalogResource — exact paths (note: catalog controller is session-rooted)', () => {
  it('info / products / product', async () => {
    const t = new MockTransport()
      .on('GET', /\/catalog$/, { body: { id: 'c1', name: 'My Shop', productCount: 5, url: 'http://shop' } })
      .on('GET', /\/catalog\/products$/, {
        body: { products: [{ id: 'p1', name: 'Widget' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } },
      })
      .on('GET', /\/catalog\/products\/p1$/, { body: { id: 'p1', name: 'Widget' } });
    const c = client(t);
    await c.catalog.info('s');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/catalog');
    const page = await c.catalog.products('s', { page: 1, limit: 20 });
    expect(page.products).toHaveLength(1);
    expect(page.pagination.total).toBe(1);
    expect(t.lastCall!.url).toContain('/catalog/products');
    expect(t.lastCall!.url).toContain('page=1');
    expect(t.lastCall!.url).toContain('limit=20');
    await c.catalog.product('s', 'p1');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/catalog/products/p1');
  });

  it('sendProduct / sendCatalog share the messages path', async () => {
    const t = new MockTransport()
      .on('POST', /\/messages\/send-product$/, { body: { messageId: 'm', timestamp: 1 } })
      .on('POST', /\/messages\/send-catalog$/, { body: { messageId: 'm', timestamp: 1 } });
    const c = client(t);
    await c.catalog.sendProduct('s', { chatId: 'a@c.us', productId: 'p1', body: 'see this' });
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/messages/send-product');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', productId: 'p1', body: 'see this' });
    await c.catalog.sendCatalog('s', { chatId: 'a@c.us', body: 'our catalog' });
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/messages/send-catalog');
    expect(t.lastCall!.body).toEqual({ chatId: 'a@c.us', body: 'our catalog' });
  });
});

describe('TemplatesResource — exact paths and bodies', () => {
  it('list / get / create / update / delete', async () => {
    const tpl = { id: 't1', sessionId: 's', name: 'welcome', body: 'Hi {{name}}', createdAt: '', updatedAt: '' };
    const t = new MockTransport()
      .on('GET', /\/templates$/, { body: [tpl] })
      .on('GET', /\/templates\/t1$/, { body: tpl })
      .on('POST', /\/templates$/, { body: tpl })
      .on('PUT', /\/templates\/t1$/, { body: { ...tpl, body: 'Hello {{name}}' } })
      .on('DELETE', /\/templates\/t1$/, { status: 204 });
    const c = client(t);
    await c.templates.list('s');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/templates');
    await c.templates.get('s', 't1');
    expect(t.lastCall!.url).toBe('http://localhost:2785/api/sessions/s/templates/t1');
    await c.templates.create('s', { name: 'welcome', body: 'Hi {{name}}' });
    expect(t.lastCall!.method).toBe('POST');
    expect(t.lastCall!.body).toEqual({ name: 'welcome', body: 'Hi {{name}}' });
    await c.templates.update('s', 't1', { body: 'Hello {{name}}' });
    expect(t.lastCall!.method).toBe('PUT');
    expect(t.lastCall!.body).toEqual({ body: 'Hello {{name}}' });
    await c.templates.delete('s', 't1');
    expect(t.lastCall!.method).toBe('DELETE');
  });
});

describe('Client exposes all resources', () => {
  it('has labels, channels, catalog, templates on the client', () => {
    const c = client(new MockTransport());
    for (const r of [
      'sessions',
      'messages',
      'contacts',
      'groups',
      'webhooks',
      'chats',
      'status',
      'health',
      'labels',
      'channels',
      'catalog',
      'templates',
    ]) {
      expect(c).toHaveProperty(r);
    }
  });
});
