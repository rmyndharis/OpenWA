// Rule CRUD must be scoped to the URL :sessionId (an OPERATOR key for one session must not read,
// edit or delete another session's rules), and the inbound evaluator carries the loop-safety
// contract: never reply to fromMe, one reply per message (first match), one reply per chat per
// cooldown window, and no failure may escape into the receive path. These run against a real
// in-memory DB so scoping and ordering are exercised end-to-end, not asserted on a mock's WHERE.
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationRule } from './entities/automation-rule.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import type { MessageService } from '../message/message.service';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';

describe('AutomationRulesService', () => {
  let ds: DataSource;
  let service: AutomationRulesService;
  let sends: Array<{ sessionId: string; chatId: string; text: string }>;
  let sendImpl: (sessionId: string, dto: { chatId: string; text: string }) => Promise<unknown>;

  const moduleRefStub = {
    get: () =>
      ({
        sendText: (sessionId: string, dto: { chatId: string; text: string }) => sendImpl(sessionId, dto),
      }) as unknown as MessageService,
  } as unknown as ModuleRef;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, AutomationRule],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    for (const id of ['sessA', 'sessB']) {
      await sessions.save(sessions.create({ id, name: id, status: SessionStatus.READY, config: {} }));
    }
    sends = [];
    sendImpl = (sessionId, dto) => {
      sends.push({ sessionId, chatId: dto.chatId, text: dto.text });
      return Promise.resolve({});
    };
    service = new AutomationRulesService(ds.getRepository(AutomationRule), moduleRefStub, undefined);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const inbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'wamid.1',
    from: '628111@c.us',
    to: '628222@c.us',
    chatId: '628111@c.us',
    body: 'hello there',
    type: 'text',
    fromMe: false,
    isGroup: false,
    ...over,
  });

  describe('per-session cap', () => {
    // Every inbound message is evaluated against every rule of its session, so an unbounded count
    // turns each message into unbounded work — the same reason the webhook fan-out is capped.
    const cappedService = (max: number): AutomationRulesService =>
      new AutomationRulesService(ds.getRepository(AutomationRule), moduleRefStub, undefined, {
        get: (_key: string, def?: number) => max ?? def,
      } as unknown as ConfigService);

    it('refuses a NEW rule at or over the cap; existing ones are grandfathered', async () => {
      const svc = cappedService(2);
      await svc.create('sessA', { name: 'r1', replyText: 'a' });
      await svc.create('sessA', { name: 'r2', replyText: 'b' });
      await expect(svc.create('sessA', { name: 'r3', replyText: 'c' })).rejects.toBeInstanceOf(BadRequestException);
      // The cap is per-session — another session is unaffected.
      await expect(svc.create('sessB', { name: 'r1', replyText: 'a' })).resolves.toBeDefined();
    });

    it('0 disables the cap', async () => {
      const svc = cappedService(0);
      for (let i = 0; i < 5; i++) await svc.create('sessA', { name: `r${i}`, replyText: 'x' });
      await expect(svc.create('sessA', { name: 'more', replyText: 'x' })).resolves.toBeDefined();
    });
  });

  describe('CRUD scoping', () => {
    it('create applies the defaults: enabled, 60s cooldown, no conditions', async () => {
      const rule = await service.create('sessA', { name: 'r', replyText: 'hi' });
      expect(rule.enabled).toBe(true);
      expect(rule.cooldownSeconds).toBe(60);
      expect(rule.conditions).toBeNull();
    });

    it('findOne returns a rule only for its owning session', async () => {
      const rule = await service.create('sessA', { name: 'r', replyText: 'hi' });
      expect((await service.findOne('sessA', rule.id)).id).toBe(rule.id);
      await expect(service.findOne('sessB', rule.id)).rejects.toThrow(NotFoundException);
    });

    it('update refuses (404) a rule owned by another session and does not mutate it', async () => {
      const rule = await service.create('sessA', { name: 'r', replyText: 'hi' });
      await expect(service.update('sessB', rule.id, { replyText: 'hijacked' })).rejects.toThrow(NotFoundException);
      expect((await ds.getRepository(AutomationRule).findOneByOrFail({ id: rule.id })).replyText).toBe('hi');
    });

    it('remove refuses (404) a rule owned by another session and does not delete it', async () => {
      const rule = await service.create('sessA', { name: 'r', replyText: 'hi' });
      await expect(service.remove('sessB', rule.id)).rejects.toThrow(NotFoundException);
      expect(await ds.getRepository(AutomationRule).countBy({ id: rule.id })).toBe(1);
    });

    it('findAll returns only the session’s rules', async () => {
      await service.create('sessA', { name: 'a', replyText: 'x' });
      await service.create('sessB', { name: 'b', replyText: 'y' });
      expect((await service.findAll('sessA')).map(r => r.name)).toEqual(['a']);
    });
  });

  describe('evaluateInbound', () => {
    it('replies through the send path when a condition matches', async () => {
      await service.create('sessA', {
        name: 'greet',
        replyText: 'welcome!',
        conditions: { conditions: [{ field: 'body', operator: 'contains', value: 'hello' }] },
      });

      await service.evaluateInbound('sessA', inbound());

      expect(sends).toEqual([{ sessionId: 'sessA', chatId: '628111@c.us', text: 'welcome!' }]);
    });

    it('a rule without conditions matches every inbound message', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack' });

      await service.evaluateInbound('sessA', inbound({ body: 'anything at all' }));

      expect(sends).toHaveLength(1);
    });

    it('never replies to the account’s own messages (fromMe)', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack' });

      await service.evaluateInbound('sessA', inbound({ fromMe: true }));

      expect(sends).toHaveLength(0);
    });

    it('skips disabled rules and non-matching conditions', async () => {
      await service.create('sessA', { name: 'off', replyText: 'no', enabled: false });
      await service.create('sessA', {
        name: 'other',
        replyText: 'no',
        conditions: { conditions: [{ field: 'body', operator: 'contains', value: 'zzz-no-match' }] },
      });

      await service.evaluateInbound('sessA', inbound());

      expect(sends).toHaveLength(0);
    });

    it('first matching rule wins — one message never gets two replies', async () => {
      const first = await service.create('sessA', { name: 'first', replyText: 'first-reply' });
      await service.create('sessA', { name: 'second', replyText: 'second-reply' });
      // createdAt has 1s precision on SQLite; pin distinct timestamps so order is the one asserted.
      await ds.getRepository(AutomationRule).update(first.id, { createdAt: new Date('2026-01-01T00:00:00Z') });

      await service.evaluateInbound('sessA', inbound());

      expect(sends.map(s => s.text)).toEqual(['first-reply']);
    });

    it('cooldown: the same rule stays quiet in the same chat, other chats unaffected', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack', cooldownSeconds: 300 });

      await service.evaluateInbound('sessA', inbound());
      await service.evaluateInbound('sessA', inbound({ id: 'wamid.2' }));
      await service.evaluateInbound('sessA', inbound({ id: 'wamid.3', chatId: '628333@c.us', from: '628333@c.us' }));

      expect(sends.map(s => s.chatId)).toEqual(['628111@c.us', '628333@c.us']);
    });

    it('cooldownSeconds 0 disables the quiet period', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack', cooldownSeconds: 0 });

      await service.evaluateInbound('sessA', inbound());
      await service.evaluateInbound('sessA', inbound({ id: 'wamid.2' }));

      expect(sends).toHaveLength(2);
    });

    it('a rejected send is swallowed, and the cooldown still holds (no retry storm)', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack', cooldownSeconds: 300 });
      sendImpl = () => Promise.reject(new Error('engine down'));

      await expect(service.evaluateInbound('sessA', inbound())).resolves.toBeUndefined();
      sendImpl = (sessionId, dto) => {
        sends.push({ sessionId, chatId: dto.chatId, text: dto.text });
        return Promise.resolve({});
      };
      await service.evaluateInbound('sessA', inbound({ id: 'wamid.2' }));

      expect(sends).toHaveLength(0);
    });

    it('a failing rule lookup resolves without throwing (receive path stays safe)', async () => {
      const broken = new AutomationRulesService(
        { find: () => Promise.reject(new Error('db gone')) } as never,
        moduleRefStub,
        undefined,
      );

      await expect(broken.evaluateInbound('sessA', inbound())).resolves.toBeUndefined();
    });

    it('tolerates a missing ModuleRef (unit wiring) without throwing', async () => {
      const bare = new AutomationRulesService(ds.getRepository(AutomationRule), undefined, undefined);
      await service.create('sessA', { name: 'all', replyText: 'ack' });

      await expect(bare.evaluateInbound('sessA', inbound())).resolves.toBeUndefined();
      expect(sends).toHaveLength(0);
    });

    it('never answers a stale message — an offline-replayed backlog must not trigger a reply burst', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack' });

      await service.evaluateInbound('sessA', inbound({ timestamp: Math.floor(Date.now() / 1000) - 3600 }));

      expect(sends).toHaveLength(0);
    });

    it('a fresh timestamp (and a missing one) still get their reply', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack', cooldownSeconds: 0 });

      await service.evaluateInbound('sessA', inbound({ timestamp: Math.floor(Date.now() / 1000) - 5 }));
      await service.evaluateInbound('sessA', inbound({ id: 'wamid.2' }));

      expect(sends).toHaveLength(2);
    });

    it('ignores messages without a chatId', async () => {
      await service.create('sessA', { name: 'all', replyText: 'ack' });

      await service.evaluateInbound('sessA', inbound({ chatId: undefined }));

      expect(sends).toHaveLength(0);
    });
  });
});
