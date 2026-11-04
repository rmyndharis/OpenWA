import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { Message, MessageDirection } from './../src/modules/message/entities/message.entity';
import { SearchProviderRegistry } from './../src/modules/search/search-provider.registry';
import { PluginSearchProvider } from './../src/modules/search/providers/plugin-search-provider';
import type { SearchHit, SearchResults } from './../src/modules/search/search.types';
import { EngineRegistry } from './../src/engine/engine-registry.service';
import type { IWhatsAppEngine } from './../src/engine/interfaces/whatsapp-engine.interface';

/**
 * End-to-end proof of the chat fence through the real HTTP stack (guard + reflector metadata + DI +
 * routing), which the unit specs mock away: a key restricted to one chat is refused on routes with no
 * chat dimension and on any other chat, and admitted where its chat is named or the list is filtered.
 * No engine runs for the main session, so an admitted request there is asserted only as "not refused by
 * the fence". The list routes read a stub engine on a second session, so what they return is asserted.
 */
describe('Chat-restricted API keys (e2e)', () => {
  const ALLOWED = '111@c.us';
  const OTHER = '222@c.us';
  let app: INestApplication<App>;
  let sessionId: string;
  let listSessionId: string; // carries listEngine
  let chatKey: string; // OPERATOR, allowedChats: [ALLOWED]
  let openKey: string; // OPERATOR, unrestricted
  let groupKey: string;

  // Every list a filtered route reads holds one chat inside the querying key's allowlist and one outside.
  const listEngine = {
    getChats: jest.fn().mockResolvedValue([{ id: ALLOWED }, { id: OTHER }]),
    getContacts: jest.fn().mockResolvedValue([{ id: ALLOWED }, { id: OTHER }]),
    getChatsByLabel: jest.fn().mockResolvedValue([{ id: ALLOWED }, { id: OTHER }]),
    getGroups: jest.fn().mockResolvedValue([
      { id: '111@g.us', name: 'allowed' },
      { id: '222@g.us', name: 'other' },
    ]),
  };

  const get = (path: string, key: string) => request(app.getHttpServer()).get(path).set('X-API-Key', key);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-chat-scope-${Date.now()}` }))).id;
    listSessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-chat-scope-lists-${Date.now()}` }))).id;
    app.get(EngineRegistry).set(listSessionId, listEngine as unknown as IWhatsAppEngine);

    const authService = app.get(AuthService);
    chatKey = (await authService.createApiKey({ name: 'e2e-chat', role: ApiKeyRole.OPERATOR, allowedChats: [ALLOWED] }))
      .rawKey;
    openKey = (await authService.createApiKey({ name: 'e2e-open', role: ApiKeyRole.OPERATOR })).rawKey;
    groupKey = (
      await authService.createApiKey({ name: 'e2e-group', role: ApiKeyRole.OPERATOR, allowedChats: ['111@g.us'] })
    ).rawKey;
    app.get(SearchProviderRegistry).setActive('builtin-fts');
    const messageRepo: Repository<Message> = app.get(getRepositoryToken(Message, 'data'));
    await messageRepo.insert(
      [ALLOWED, OTHER, ALLOWED].map((chatId, index) => ({
        sessionId,
        chatId,
        from: chatId,
        to: '333@c.us',
        body: 'scopingprobe',
        type: 'text' as const,
        direction: MessageDirection.INCOMING,
        timestamp: index + 1,
      })),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a route with no chat dimension, which an unrestricted key reaches', async () => {
    const res = await get(`/api/sessions/${sessionId}/webhooks`, chatKey).expect(403);
    expect((res.body as { message: string }).message).toBe('API key is restricted to selected chats');
    expect((await get(`/api/sessions/${sessionId}/webhooks`, openKey)).status).not.toBe(403);
  });

  it('refuses a chat outside the allowlist in a path param and in a send body', async () => {
    const res = await get(`/api/sessions/${sessionId}/contacts/${OTHER}`, chatKey).expect(403);
    expect((res.body as { message: string }).message).toBe('API key not authorized for this chat');

    await request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/messages/send-text`)
      .set('X-API-Key', chatKey)
      .send({ chatId: OTHER, text: 'hi' })
      .expect(403);
  });

  it('admits the allowed chat', async () => {
    expect((await get(`/api/sessions/${sessionId}/contacts/${ALLOWED}`, chatKey)).status).not.toBe(403);
  });

  // Default deny answers 403 on the key's OWN chat as well when a mark is lost, and a refusal on another
  // chat is a 403 either way, so the cases above cannot tell a marked route from an unmarked one. Each row
  // shows both halves: the allowed chat gets past the fence, and another chat is refused by the chat
  // check (not the blanket refusal), which also shows the route exists and the fence reads that field.
  const admitsAllowedAndRefusesOther = async (route: string, body: (chatId: string) => object) => {
    const send = (chatId: string) =>
      request(app.getHttpServer())
        .post(`/api/sessions/${sessionId}/${route}`)
        .set('X-API-Key', chatKey)
        .send(body(chatId));

    expect((await send(ALLOWED)).status).not.toBe(403);

    const refused = await send(OTHER).expect(403);
    expect((refused.body as { message: string }).message).toBe('API key not authorized for this chat');
  };

  it.each<[string, (chatId: string) => object]>([
    ['messages/send-text', chatId => ({ chatId, text: 'hi' })],
    ['messages/reply', chatId => ({ chatId, quotedMessageId: 'wamid.quoted', text: 'hi' })],
    ['messages/send-bulk', chatId => ({ messages: [{ chatId, text: 'hi' }] })],
    ['messages/react', chatId => ({ chatId, messageId: 'wamid.target', emoji: 'ok' })],
    ['chats/read', chatId => ({ chatId })],
    ['chats/mute', chatId => ({ chatId, muteUntil: 1_800_000_000_000 })],
  ])('POST %s admits the allowed chat and refuses another', admitsAllowedAndRefusesOther);

  // Forward names two chats and the fence reads both. With one chat in both fields, a guard that stopped
  // reading either field would still pass, so each row varies one field and keeps the allowed chat in the
  // other: a chat outside the allowlist as the source, and as the destination.
  it.each<[string, (chatId: string) => object]>([
    ['fromChatId', chatId => ({ fromChatId: chatId, toChatId: ALLOWED, messageId: 'wamid.source' })],
    ['toChatId', chatId => ({ fromChatId: ALLOWED, toChatId: chatId, messageId: 'wamid.source' })],
  ])('POST messages/forward admits the allowed chat and refuses another in %s', (_field, body) =>
    admitsAllowedAndRefusesOther('messages/forward', body),
  );

  it('reads stored messages only for a chat it names', async () => {
    const path = `/api/sessions/${sessionId}/messages`;
    const missing = await get(path, chatKey).expect(403);
    expect((missing.body as { message: string }).message).toBe(
      'chatId is required for a key restricted to selected chats',
    );
    await get(`${path}?chatId=${OTHER}`, chatKey).expect(403);
    await get(`${path}?chatId=${ALLOWED}`, chatKey).expect(200);
    await get(path, openKey).expect(200);
  });

  // A list route admits a restricted key because its handler filters the engine's list down to the key's
  // chats, and the key reaches that filter only through @CurrentApiKey(). A handler that lost it filters
  // with no key, which reads as unrestricted, and lists every chat of the session.
  it.each<[string, () => string, string, string]>([
    ['chats', () => chatKey, ALLOWED, OTHER],
    ['contacts', () => chatKey, ALLOWED, OTHER],
    ['labels/1/chats', () => chatKey, ALLOWED, OTHER],
    ['groups', () => groupKey, '111@g.us', '222@g.us'],
  ])(
    'GET %s lists only the allowed chat to a restricted key, and both to an open key',
    async (route, key, allowed, other) => {
      const listed = async (apiKey: string) =>
        ((await get(`/api/sessions/${listSessionId}/${route}`, apiKey).expect(200)).body as Array<{ id: string }>).map(
          item => item.id,
        );
      expect(await listed(key())).toEqual([allowed]);
      expect(await listed(openKey)).toEqual([allowed, other]);
    },
  );

  it('admits search for a restricted key and fences its optional ?chatId=', async () => {
    const outside = await get(`/api/search?q=hi&chatId=${OTHER}`, chatKey).expect(403);
    expect((outside.body as { message: string }).message).toBe('API key not authorized for this chat');
    const path = `/api/search?q=scopingprobe&sessionId=${sessionId}`;
    const pages: SearchHit[] = [];
    for (const offset of [0, 1, 2]) {
      const page = await get(`${path}&limit=1&offset=${offset}`, chatKey).expect(200);
      const body = page.body as SearchResults;
      expect(body.total).toBe(2);
      pages.push(...body.hits);
    }
    expect(pages.map(hit => hit.chatId)).toEqual([ALLOWED, ALLOWED]);
    expect(new Set(pages.map(hit => hit.messageId)).size).toBe(2);
    expect(((await get(path, openKey).expect(200)).body as SearchResults).total).toBe(3);
  });

  it('refuses plugin search for a chat-restricted key before invoking the worker', async () => {
    const registry = app.get(SearchProviderRegistry);
    const dispatchSearch = jest
      .fn()
      .mockResolvedValue({ ok: true, results: { hits: [], total: 731, tookMs: 1, provider: 'plugin:e2e' } });
    registry.register(new PluginSearchProvider('e2e', 'E2E', { dispatchSearch, healthCheck: jest.fn() }, 1000));
    registry.setActive('plugin:e2e');
    try {
      const refused = await get('/api/search?q=scopingprobe', chatKey).expect(403);
      expect((refused.body as { message: string }).message).toBe(
        'Chat-restricted search requires the built-in search provider',
      );
      expect(dispatchSearch).not.toHaveBeenCalled();
      expect(((await get('/api/search?q=scopingprobe', openKey).expect(200)).body as SearchResults).total).toBe(731);
      expect(dispatchSearch).toHaveBeenCalledTimes(1);
    } finally {
      registry.unregister('plugin:e2e');
      registry.setActive('builtin-fts');
    }
  });

  it('admits group detail and settings for the allowed group, refuses any other', async () => {
    const detail = await get(`/api/sessions/${sessionId}/groups/222@g.us`, groupKey).expect(403);
    expect((detail.body as { message: string }).message).toBe('API key not authorized for this chat');
    await get(`/api/sessions/${sessionId}/groups/222@g.us/settings`, groupKey).expect(403);
    expect((await get(`/api/sessions/${sessionId}/groups/111@g.us`, groupKey)).status).not.toBe(403);
    expect((await get(`/api/sessions/${sessionId}/groups/111@g.us/settings`, groupKey)).status).not.toBe(403);
    await request(app.getHttpServer())
      .put(`/api/sessions/${sessionId}/groups/222@g.us/settings`)
      .set('X-API-Key', groupKey)
      .send({ announce: true })
      .expect(403);
    const allowed = await request(app.getHttpServer())
      .put(`/api/sessions/${sessionId}/groups/111@g.us/settings`)
      .set('X-API-Key', groupKey)
      .send({ announce: true });
    expect(allowed.status).not.toBe(403);
  });
});
