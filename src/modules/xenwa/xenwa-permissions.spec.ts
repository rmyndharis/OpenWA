import { classifySessionRoute, decideRoute, normalizePermissions } from './xenwa-permissions';
import { XenwaAccessService, type XenwaActorContext } from './xenwa-access.service';
import type { XenwaUser } from './entities/xenwa-user.entity';

describe('XenWA permission classifier', () => {
  const S = '7f1c2a9e-0000-4000-8000-000000000001';

  it.each([
    ['GET', `/api/sessions/${S}/chats`, 'read'],
    ['GET', `/api/sessions/${S}/messages/123@c.us/history`, 'read'],
    ['GET', `/api/sessions/${S}`, 'read'],
    ['GET', `/api/sessions/${S}/qr`, 'settings'],
    ['GET', `/api/sessions/${S}/webhooks`, 'settings'],
    ['POST', `/api/sessions/${S}/messages/send-text`, 'send'],
    ['POST', `/api/sessions/${S}/chats/read`, 'read'],
    ['POST', `/api/sessions/${S}/presence/subscribe`, 'read'],
    ['POST', `/api/sessions/${S}/chats/archive`, 'send'],
    ['POST', `/api/sessions/${S}/messages/send-bulk`, 'campaigns'],
    ['POST', `/api/sessions/${S}/messages/batch/abc/cancel`, 'campaigns'],
    ['PUT', `/api/sessions/${S}/contacts/123@c.us`, 'contacts'],
    ['POST', `/api/sessions/${S}/templates`, 'contacts'],
    ['POST', `/api/sessions/${S}/groups`, 'contacts'],
    ['POST', `/api/sessions/${S}/start`, 'settings'],
    ['PATCH', `/api/sessions/${S}/config`, 'settings'],
    ['POST', `/api/sessions/${S}/webhooks`, 'settings'],
    ['DELETE', `/api/sessions/${S}`, 'owner'],
    ['POST', `/api/sessions/${S}/something-new`, 'owner'],
    ['GET', `/api/stats/sessions/${S}`, 'read'],
  ])('%s %s needs %s', (method, path, need) => {
    const d = decideRoute(method, path, undefined);
    expect(d).toEqual({ kind: 'session', sessionId: S, requirement: need });
  });

  it.each([
    ['GET', '/api/sessions'],
    ['GET', '/api/sessions/stats/overview'],
    ['POST', '/api/auth/validate'],
    ['GET', '/api/xenwa/me'],
    ['POST', '/api/xenwa/accounts'],
  ])('allows global %s %s', (method, path) => {
    expect(decideRoute(method, path).kind).toBe('global-allowed');
  });

  it.each([
    ['POST', '/api/sessions'],
    ['GET', '/api/audit'],
    ['GET', '/api/infra/config'],
    ['POST', '/api/auth/api-keys'],
    ['GET', '/api/plugins'],
    ['GET', '/api/settings'],
  ])('refuses global %s %s', (method, path) => {
    expect(decideRoute(method, path).kind).toBe('global-denied');
  });

  it('prefers the guard-resolved session id', () => {
    expect(decideRoute('GET', '/api/sessions/x/chats', 'real-id')).toMatchObject({ sessionId: 'real-id' });
  });

  it('defaults unknown write segments to owner', () => {
    expect(classifySessionRoute('POST', ['brand-new'])).toBe('owner');
  });

  it('normalizes permissions: drops unknown, always includes read', () => {
    expect(normalizePermissions(['send', 'bogus', 'send'])).toEqual(['read', 'send']);
    expect(normalizePermissions(null)).toEqual(['read']);
  });
});

describe('XenwaAccessService.allows', () => {
  const ctx = (over: Partial<XenwaActorContext> = {}): XenwaActorContext => ({
    user: {} as XenwaUser,
    isPlatformAdmin: false,
    paused: new Set(),
    sessions: new Map([
      ['own', { role: 'owner', permissions: ['read', 'send', 'campaigns', 'contacts', 'settings'] }],
      ['shared', { role: 'member', permissions: ['read', 'send'] }],
    ]),
    ...over,
  });

  it('owner may do everything on their account', () => {
    expect(XenwaAccessService.allows(ctx(), 'own', 'owner')).toBe(true);
    expect(XenwaAccessService.allows(ctx(), 'own', 'campaigns')).toBe(true);
  });

  it('member is limited to granted permissions', () => {
    expect(XenwaAccessService.allows(ctx(), 'shared', 'send')).toBe(true);
    expect(XenwaAccessService.allows(ctx(), 'shared', 'campaigns')).toBe(false);
    expect(XenwaAccessService.allows(ctx(), 'shared', 'owner')).toBe(false);
  });

  it('no grant means no access (revoked users lose access)', () => {
    expect(XenwaAccessService.allows(ctx(), 'other', 'read')).toBe(false);
  });

  it('a paused number is read-only, even for its owner', () => {
    const c = ctx({ paused: new Set(['own']) });
    expect(XenwaAccessService.allows(c, 'own', 'read')).toBe(true);
    expect(XenwaAccessService.allows(c, 'own', 'send')).toBe(false);
  });

  it('platform admin bypasses', () => {
    expect(XenwaAccessService.allows(ctx({ isPlatformAdmin: true }), 'other', 'owner')).toBe(true);
  });
});
