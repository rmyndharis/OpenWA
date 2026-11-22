import { DataSource } from 'typeorm';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';

const GONE = '99999999-9999-4999-8999-999999999999';
const KEPT = '11111111-1111-4111-8111-111111111111';

const anyFn = (): unknown =>
  new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });

/** The real SessionService, lifecycle and engine controls, with real error and restriction stores. */
function build(ownership?: SessionOwnershipService) {
  const errors = new SessionErrorStore();
  const restrictions = new SessionRestrictionStore();
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn(), setOwnIntent: jest.fn() };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    {} as never,
    {} as never,
    {} as never,
    registry,
    { clear: jest.fn(), start: jest.fn(), stop: jest.fn() } as never,
    {} as never,
    errors,
    restrictions,
    presence as never,
    anyFn() as never,
    anyFn() as never,
    anyFn() as never,
    anyFn() as never,
  );
  const service = new SessionService(
    {} as never,
    {} as never,
    {} as never,
    registry,
    {} as never,
    errors,
    restrictions,
    {} as never,
    {} as never,
    lifecycle,
    {} as never,
    undefined,
    ownership,
  );
  return { service, errors, restrictions, presence };
}

// An infra import replaces the sessions table without a delete, so the sessions it drops never pass through the
// delete's own cleanup. What this process keeps for them (a restriction that has no expiry above all, which the
// restricted-sessions gauge counts) must go once the import has committed.
describe('what a session whose row is gone leaves in memory', () => {
  it('forgetSession() drops the restriction and the error entry of that session only', () => {
    const { service, errors, restrictions, presence } = build();
    for (const id of [GONE, KEPT]) {
      restrictions.set(id, { kind: 'tos_block', code: 'TOS_BLOCK' });
      errors.set(id, 'Account blocked');
    }

    service.forgetSession(GONE);

    expect(restrictions.get(GONE)).toBeUndefined();
    expect(errors.get(GONE)).toBeUndefined();
    expect(presence.clear).toHaveBeenCalledWith(GONE);
    expect(restrictions.size()).toBe(1);
    expect(restrictions.get(KEPT)).toEqual({ kind: 'tos_block', code: 'TOS_BLOCK' });
    expect(errors.get(KEPT)).toBe('Account blocked');
  });

  it('forgetSession() drops the claim this node held, so the next heartbeat reports no loss', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    });
    await dataSource.initialize();
    try {
      const sessions = dataSource.getRepository(Session);
      const row = await sessions.save(
        sessions.create({ name: 'removed', status: SessionStatus.DISCONNECTED, config: {} }),
      );
      const cfg = { get: (k: string) => ({ 'session.nodeId': 'node-a', 'session.leaseTtlMs': 60_000 })[k] } as never;
      const ownership = new SessionOwnershipService(sessions, cfg);
      const lost = jest.fn();
      ownership.onLeaseLoss(lost);
      expect(await ownership.claim(row.id)).toBe(true);
      // The import's replace removes the row.
      await sessions.delete(row.id);

      build(ownership).service.forgetSession(row.id);
      await ownership.renew();

      expect(lost).not.toHaveBeenCalled();
    } finally {
      await dataSource.destroy();
    }
  });

  it('forgetSession() and stopped-session delete() clear cached automation rules and cooldowns via MessageProjector', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        AutomationRule,
        Message,
        MessageBatch,
        SendIdempotencyKey,
        Webhook,
        WebhookOutboxEvent,
        WebhookDeliveryFailure,
        IntegrationDeliveryFailure,
        Template,
        BaileysStoredMessage,
        ChatState,
        StatusUpdate,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    try {
      const sessions = dataSource.getRepository(Session);
      const rulesRepo = dataSource.getRepository(AutomationRule);
      for (const id of [GONE, KEPT]) {
        await sessions.save(sessions.create({ id, name: id, status: SessionStatus.DISCONNECTED, config: {} }));
      }
      const sends: string[] = [];
      const moduleRef = {
        get: () => ({
          sendText: (sessionId: string) => {
            sends.push(sessionId);
            return Promise.resolve({});
          },
        }),
      } as never;
      const registry = new EngineRegistry();
      const automationRules = new AutomationRulesService(
        rulesRepo,
        sessions,
        moduleRef,
        undefined,
        undefined,
        registry,
      );
      await automationRules.create(GONE, { name: 'r1', replyText: 'hi', cooldownSeconds: 300 });
      await automationRules.create(KEPT, { name: 'r2', replyText: 'hi', cooldownSeconds: 300 });

      const findSpy = jest.spyOn(rulesRepo, 'find');
      const inboundMsg = {
        id: 'wamid.1',
        from: '628111@c.us',
        to: '628222@c.us',
        chatId: '628111@c.us',
        body: 'hello',
        type: 'text',
        fromMe: false,
        isGroup: false,
      };
      // Warm cache and cooldowns for both sessions (no live engine registered for GONE).
      await automationRules.evaluateInbound(GONE, inboundMsg);
      await automationRules.evaluateInbound(KEPT, inboundMsg);
      expect(findSpy).toHaveBeenCalledTimes(2);
      expect(sends).toEqual([GONE, KEPT]);

      const projector = new MessageProjector(
        dataSource.getRepository(Message),
        sessions,
        registry,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
        undefined,
        undefined,
        automationRules,
      );
      const lifecycle = new SessionEngineLifecycle(
        sessions,
        dataSource,
        { purgeSessionData: jest.fn().mockResolvedValue(undefined) } as never,
        registry,
        { clear: jest.fn(), start: jest.fn(), stop: jest.fn() } as never,
        projector,
        new SessionErrorStore(),
        new SessionRestrictionStore(),
        { clear: jest.fn(), getOwnIntent: jest.fn(), setOwnIntent: jest.fn() } as never,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
      );

      // Delete the already-stopped session (EngineRegistry.onRetire does not fire when no engine is live).
      await lifecycle.delete(GONE);

      // GONE's cached rule list and cooldowns are cleared; KEPT stays cached.
      await automationRules.evaluateInbound(KEPT, { ...inboundMsg, id: 'wamid.2' });
      expect(findSpy).toHaveBeenCalledTimes(2);
      await automationRules.evaluateInbound(GONE, { ...inboundMsg, id: 'wamid.3' });
      expect(findSpy).toHaveBeenCalledTimes(3);
      expect(sends).toEqual([GONE, KEPT]);

      // Direct forgetSession() (used after infra replace-all import) also clears KEPT's cache and cooldown.
      lifecycle.forgetSession(KEPT);
      await automationRules.evaluateInbound(KEPT, { ...inboundMsg, id: 'wamid.4' });
      expect(findSpy).toHaveBeenCalledTimes(4);
      expect(sends).toEqual([GONE, KEPT, KEPT]);

      // MessageProjector.forgetSession() is a safe no-op when automationRules is omitted.
      const bareProjector = new MessageProjector(
        dataSource.getRepository(Message),
        sessions,
        registry,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
        anyFn() as never,
      );
      expect(() => bareProjector.forgetSession(KEPT)).not.toThrow();
    } finally {
      await dataSource.destroy();
    }
  });
});
