import { describe, expect, it } from 'vitest';
import { OpenWAClient } from '../src';
import { MockTransport } from './helpers';

function client(t: MockTransport): OpenWAClient {
  return new OpenWAClient({ baseUrl: 'http://x', apiKey: 'k', fetch: t.asFetch() });
}

describe('SessionsResource — exact paths', () => {
  it('list/get/create/delete/start/stop/forceKill', async () => {
    const t = new MockTransport()
      .on('GET', /\/sessions$/, { body: [] })
      .on('GET', /\/sessions\/s1$/, { body: { id: 's1', name: 'n', status: 'ready' } })
      .on('POST', /\/sessions$/, { body: { id: 's1', name: 'n', status: 'created' } })
      .on('DELETE', /\/sessions\/s1$/, { status: 204 })
      .on('POST', /\/sessions\/s1\/start$/, { body: { id: 's1', name: 'n', status: 'initializing' } })
      .on('POST', /\/sessions\/s1\/stop$/, { body: { id: 's1', name: 'n', status: 'disconnected' } })
      .on('POST', /\/sessions\/s1\/force-kill$/, { body: { id: 's1', name: 'n', status: 'disconnected' } });
    const c = client(t);
    await c.sessions.list();
    expect(t.lastCall!.url).toBe('http://x/api/sessions');
    await c.sessions.get('s1');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1');
    await c.sessions.create({ name: 'n' });
    expect(t.lastCall!.body).toEqual({ name: 'n' });
    await c.sessions.start('s1');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1/start');
    await c.sessions.stop('s1');
    await c.sessions.forceKill('s1');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1/force-kill');
    await c.sessions.delete('s1');
    expect(t.lastCall!.method).toBe('DELETE');
  });

  it('getQrCode / requestPairingCode / stats', async () => {
    const t = new MockTransport()
      .on('GET', /\/qr$/, { body: { qrCode: 'data:image/png;base64,xxx', status: 'qr_ready' } })
      .on('POST', /\/pairing-code$/, { body: { pairingCode: 'ABCD1234', status: 'qr_ready' } })
      .on('GET', /\/stats\/overview$/, {
        body: { total: 1, active: 1, ready: 1, disconnected: 0, byStatus: { ready: 1 } },
      });
    const c = client(t);
    await c.sessions.getQrCode('s1');
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1/qr');
    await c.sessions.requestPairingCode('s1', { phoneNumber: '628123456789' });
    expect(t.lastCall!.url).toBe('http://x/api/sessions/s1/pairing-code');
    expect(t.lastCall!.body).toEqual({ phoneNumber: '628123456789' });
    await c.sessions.stats();
    expect(t.lastCall!.url).toBe('http://x/api/sessions/stats/overview');
  });
});
