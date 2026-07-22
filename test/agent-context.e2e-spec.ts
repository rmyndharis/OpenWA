// archiver v8 is ESM-only and is pulled in by the global storage module.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// This must be set before AppModule is evaluated because the route is feature-gated at module load.
process.env.ALLOW_DEV_API_KEY = 'true';
process.env.AGENT_CONTEXT_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { Message, MessageDirection, MessageStatus } from '../src/modules/message/entities/message.entity';
import { MessageQuote } from '../src/modules/message/entities/message-quote.entity';
import { MessageReaction } from '../src/modules/message/entities/message-reaction.entity';
import { LidMappingStoreService } from '../src/engine/identity/lid-mapping-store.service';

describe('GET /api/sessions/:sessionId/agent-context/messages/:messageId (e2e)', () => {
  let app: INestApplication<App>;
  let messages: Repository<Message>;
  let quotes: Repository<MessageQuote>;
  let reactions: Repository<MessageReaction>;
  let viewerKey: string;
  const sessionId = 'agent-session';
  const targetId = '11111111-1111-4111-8111-111111111111';
  const base = `/api/sessions/${sessionId}/agent-context/messages/${targetId}`;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    messages = app.get<Repository<Message>>(getRepositoryToken(Message, 'data'));
    quotes = app.get<Repository<MessageQuote>>(getRepositoryToken(MessageQuote, 'data'));
    reactions = app.get<Repository<MessageReaction>>(getRepositoryToken(MessageReaction, 'data'));
    const auth = app.get(AuthService);
    viewerKey = (
      await auth.createApiKey({ name: 'agent-context-viewer', role: ApiKeyRole.VIEWER, allowedSessions: [sessionId] })
    ).rawKey;
    await app.get(LidMappingStoreService).remember('bridge-lid', '15551234567', sessionId);

    await messages.insert([
      {
        id: targetId,
        sessionId,
        chatId: '15551234567@c.us',
        from: '15551234567@c.us',
        to: 'self@c.us',
        body: 'latest incoming message',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1700000000,
        status: MessageStatus.READ,
        metadata: { media: { data: 'never expose this' }, raw: 'never expose this either' },
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        sessionId,
        chatId: '15551234567@c.us',
        from: index % 2 ? 'self@c.us' : '15551234567@c.us',
        to: index % 2 ? '15551234567@c.us' : 'self@c.us',
        body: `recent ${index}`,
        type: 'text',
        direction: index % 2 ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
        timestamp: 1699999000 + index,
      })),
      {
        id: '00000000-0000-4000-8000-000000000007',
        sessionId,
        chatId: 'bridge-lid@lid',
        from: 'bridge-lid@lid',
        to: 'self@c.us',
        body: 'mapped LID history is in the canonical chat bucket',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1699999999,
      },
      {
        id: '00000000-0000-4000-8000-000000000010',
        sessionId,
        chatId: '15551234567@s.whatsapp.net',
        from: '15551234567@s.whatsapp.net',
        to: 'self@c.us',
        body: 'direct protocol JID history is in the canonical chat bucket',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1699999998,
      },
      {
        id: '00000000-0000-4000-8000-000000000009',
        sessionId,
        chatId: '15551234567@c.us',
        from: '15551234567@c.us',
        to: 'self@c.us',
        body: 'must be excluded: after trigger',
        type: 'text',
        direction: MessageDirection.INCOMING,
        // Delayed DB arrival does not matter: this WhatsApp event happened after the selected trigger.
        timestamp: 1700000001,
      },
      {
        // Lower UUID must not be mistaken for an earlier event when WhatsApp timestamps tie.
        id: '00000000-0000-4000-8000-000000000008',
        sessionId,
        chatId: '15551234567@c.us',
        from: '15551234567@c.us',
        to: 'self@c.us',
        body: 'must be excluded: later same-second message',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1700000000,
      },
    ]);
    await quotes.insert({ messageId: targetId, sessionId, quotedWaMessageId: 'quoted-wa-id', body: 'quoted context' });
    await reactions.insert({ messageId: targetId, senderId: '15551234567@c.us', sessionId, emoji: '👍' });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* named TypeORM connection shutdown quirk in the e2e harness */
    }
  });

  it('is viewer-readable but session-scoped, bounded, and does not expose metadata or send capability', async () => {
    const response = await request(app.getHttpServer())
      .get(`${base}?limit=1000`)
      .set('X-API-Key', viewerKey)
      .expect(200);

    const body = response.body as {
      schema: string;
      message: {
        canonicalChat: { canonicalJid: string };
        body: string;
        receipt: { status: string };
        quote: { messageId: string };
        reactions: unknown[];
      };
      conversation: Array<{ id: string; body?: string }>;
    };
    expect(body.schema).toBe('openwa.agent-context.v1');
    expect(body.message.canonicalChat.canonicalJid).toBe('15551234567@c.us');
    expect(body.message.body).toBe('latest incoming message');
    expect(body.message.receipt).toEqual({ status: MessageStatus.READ });
    expect(body.message.quote).toEqual({ messageId: 'quoted-wa-id', body: 'quoted context' });
    expect(body.message.reactions).toEqual([
      { sender: { canonicalJid: '15551234567@c.us', kind: 'person', resolution: 'phone-resolved' }, emoji: '👍' },
    ]);
    expect(body.conversation).toHaveLength(6);
    expect(body.conversation.map(message => message.id)).toContain(targetId); // trigger is included in its own bounded window
    expect(body.conversation.map(message => message.body)).toContain(
      'mapped LID history is in the canonical chat bucket',
    );
    expect(body.conversation.map(message => message.body)).toContain(
      'direct protocol JID history is in the canonical chat bucket',
    );
    expect(body.conversation.map(message => message.body)).not.toContain('must be excluded: after trigger');
    expect(body.conversation.map(message => message.body)).not.toContain('must be excluded: later same-second message');
    expect(JSON.stringify(body)).not.toContain('never expose');

    await request(app.getHttpServer()).post(base).set('X-API-Key', viewerKey).send({ text: 'send this' }).expect(404);
    await request(app.getHttpServer()).get(base).expect(401);
  });

  it('does not allow a session-scoped key to read another session', async () => {
    await request(app.getHttpServer())
      .get(`/api/sessions/other-session/agent-context/messages/${targetId}`)
      .set('X-API-Key', viewerKey)
      // AuthService treats a session allow-list mismatch as an authentication failure, matching the
      // existing session-scoped API contract. The important boundary is that no context is returned.
      .expect(401);
  });
});

describe('AGENT_CONTEXT_ENABLED gate (real AppModule imports)', () => {
  const moduleImportedWhen = (value: string | undefined): boolean => {
    const previous = process.env.AGENT_CONTEXT_ENABLED;
    if (value === undefined) delete process.env.AGENT_CONTEXT_ENABLED;
    else process.env.AGENT_CONTEXT_ENABLED = value;
    try {
      let imported = false;
      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports -- evaluate the actual module gate fresh. */
        const { AppModule: IsolatedAppModule } = require('../src/app.module') as typeof import('../src/app.module');
        const { AgentContextModule } =
          require('../src/modules/agent-context/agent-context.module') as typeof import('../src/modules/agent-context/agent-context.module');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const imports: unknown[] = (Reflect.getMetadata('imports', IsolatedAppModule) as unknown[]) ?? [];
        imported = imports.includes(AgentContextModule);
      });
      return imported;
    } finally {
      if (previous === undefined) delete process.env.AGENT_CONTEXT_ENABLED;
      else process.env.AGENT_CONTEXT_ENABLED = previous;
    }
  };

  it('is absent by default and only imports when explicitly enabled', () => {
    expect(moduleImportedWhen(undefined)).toBe(false);
    expect(moduleImportedWhen('true')).toBe(true);
  });
});
