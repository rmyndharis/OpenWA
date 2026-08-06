import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { userPart } from '../../engine/identity/wa-id';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { evaluateFilters } from '../webhook/filters/filter-evaluator';
import type { MessageService } from '../message/message.service';
import { AutomationRule } from './entities/automation-rule.entity';
import { CreateAutomationRuleDto, UpdateAutomationRuleDto } from './dto/automation-rule.dto';

/** Entries above this size trigger a sweep of expired cooldowns before inserting the next one. */
const COOLDOWN_SWEEP_THRESHOLD = 10_000;

/**
 * Messages older than this never get an automated answer. A reconnect replays the offline-queued
 * backlog through the same inbound path; answering it would burst-reply every stale message — and
 * it is the unbounded arm of an autoreply-vs-autoreply loop, where each side answers the other's
 * queued message only after its own cooldown has long expired.
 */
const MAX_MESSAGE_AGE_SECONDS = 300;

/**
 * Single-message autoreply rules: evaluated on every inbound message, first matching rule replies
 * into the chat through the ordinary send path.
 *
 * The reply is sent via `MessageService.sendText`, which the module graph cannot inject directly:
 * `MessageModule` imports `SessionModule`, and this module is imported BY `SessionModule` (the
 * projector calls `evaluateInbound`), so a constructor dependency here would close a module cycle.
 * `ModuleRef.get(..., { strict: false })` resolves it lazily at first use instead — the same escape
 * hatch `AuthService` uses. In unit contexts without a ModuleRef the evaluator logs and skips.
 */
@Injectable()
export class AutomationRulesService {
  private readonly logger = createLogger('AutomationRulesService');

  /** `${ruleId}:${chatId}` -> epoch ms until which the rule stays quiet in that chat. Per-process. */
  private readonly cooldowns = new Map<string, number>();

  private messageService?: MessageService;

  constructor(
    @InjectRepository(AutomationRule, 'data')
    private readonly ruleRepository: Repository<AutomationRule>,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async create(sessionId: string, dto: CreateAutomationRuleDto): Promise<AutomationRule> {
    // Per-session cap, the same shape (and softness) the webhook fan-out cap has: every inbound
    // message is evaluated against every rule of its session, so an unbounded count turns each
    // message into unbounded work. A concurrent create can race the count — the cap bounds
    // amplification, it is not an invariant. Rules already above it are left alone.
    const maxPerSession = this.configService?.get<number>('automation.maxPerSession', 32) ?? 32;
    if (maxPerSession > 0) {
      const existing = await this.ruleRepository.count({ where: { sessionId } });
      if (existing >= maxPerSession) {
        throw new BadRequestException(
          `Automation rule limit reached for this session (${existing}/${maxPerSession}); delete one before adding another`,
        );
      }
    }
    const rule = this.ruleRepository.create({
      sessionId,
      name: dto.name,
      replyText: dto.replyText,
      conditions: dto.conditions ?? null,
      cooldownSeconds: dto.cooldownSeconds ?? 60,
      enabled: dto.enabled ?? true,
    });
    return this.ruleRepository.save(rule);
  }

  async findAll(sessionId: string): Promise<AutomationRule[]> {
    // id is the tiebreak: createdAt has 1-second precision on SQLite, so rules created together
    // would otherwise have an unstable order — and order here IS the evaluation order.
    return this.ruleRepository.find({ where: { sessionId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async findOne(sessionId: string, id: string): Promise<AutomationRule> {
    const rule = await this.ruleRepository.findOne({ where: { id, sessionId } });
    if (!rule) {
      throw new NotFoundException(`Automation rule ${id} not found`);
    }
    return rule;
  }

  async update(sessionId: string, id: string, dto: UpdateAutomationRuleDto): Promise<AutomationRule> {
    const rule = await this.findOne(sessionId, id);
    if (dto.name !== undefined) rule.name = dto.name;
    if (dto.replyText !== undefined) rule.replyText = dto.replyText;
    if (dto.conditions !== undefined) rule.conditions = dto.conditions;
    if (dto.cooldownSeconds !== undefined) rule.cooldownSeconds = dto.cooldownSeconds;
    if (dto.enabled !== undefined) rule.enabled = dto.enabled;
    return this.ruleRepository.save(rule);
  }

  async remove(sessionId: string, id: string): Promise<void> {
    const rule = await this.findOne(sessionId, id);
    await this.ruleRepository.remove(rule);
  }

  /**
   * Evaluate one inbound message against the session's rules; first match replies.
   *
   * Called fire-and-forget from the projector's dispatch stage, which runs at most once per inbound
   * message (the UNIQUE(sessionId, waMessageId) insert oracle) — so a rule sees no engine re-fires.
   * Everything here must swallow its own failures: a broken rule, a dead DB or a refused send must
   * never surface into the receive path.
   *
   * `fromMe` is guarded HERE because the inbound path does not filter it — some engine deliveries
   * carry the account's own messages, and answering yourself is the shortest possible reply loop.
   */
  async evaluateInbound(sessionId: string, message: Record<string, unknown>): Promise<void> {
    if (message.fromMe === true) return;
    const chatId = typeof message.chatId === 'string' ? message.chatId : null;
    if (!chatId) return;
    // Freshness gate (see MAX_MESSAGE_AGE_SECONDS). A missing timestamp counts as fresh — losing
    // one legitimate reply to a mapper quirk is worse than answering a possibly old message once.
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return;

    let rules: AutomationRule[];
    try {
      rules = await this.ruleRepository.find({
        where: { sessionId, enabled: true },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
    } catch (error) {
      this.logger.warn('Automation rule lookup failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (rules.length === 0) return;

    // Same lid->phone resolution the webhook filter match uses, so a phone-valued sender condition
    // matches a lid-addressed sender identically in both places.
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.getCached(userPart(jid)) ?? null;

    // First match wins: one inbound message never produces more than one automated reply, and rule
    // order (creation order) is the tiebreak the operator can reason about.
    const rule = rules.find(candidate =>
      evaluateFilters(candidate.conditions, 'message.received', message, resolveLid),
    );
    if (!rule) return;
    if (this.inCooldown(rule, chatId)) return;
    // Enter the cooldown BEFORE the send: a burst of matching messages must collapse to one reply
    // even while the first send is still in flight.
    this.enterCooldown(rule, chatId);

    try {
      const messageService = this.resolveMessageService();
      if (!messageService) return;
      await messageService.sendText(sessionId, { chatId, text: rule.replyText });
      this.logger.log('Automation rule replied', { sessionId, ruleId: rule.id, chatId });
    } catch (error) {
      // The send path already persisted/audited its own failure; here it only must not propagate.
      this.logger.warn('Automation rule reply failed', {
        sessionId,
        ruleId: rule.id,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveMessageService(): MessageService | undefined {
    if (!this.messageService) {
      try {
        // Deferred require, not a static import: a value-import of MessageService here closes the
        // file cycle session (projector) -> automation -> message -> session, and whichever class
        // evaluates last in that cycle is `undefined` while Nest builds the graph. By reply time
        // every module is loaded, so requiring the token lazily sidesteps the cycle entirely.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { MessageService: token } = require('../message/message.service') as {
          MessageService: new (...args: never[]) => MessageService;
        };
        this.messageService = this.moduleRef?.get(token, { strict: false });
      } catch (error) {
        this.logger.warn('MessageService is not resolvable; automation replies are disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }
    return this.messageService;
  }

  private inCooldown(rule: AutomationRule, chatId: string): boolean {
    if (!rule.cooldownSeconds) return false;
    const until = this.cooldowns.get(`${rule.id}:${chatId}`);
    return until !== undefined && until > Date.now();
  }

  private enterCooldown(rule: AutomationRule, chatId: string): void {
    if (!rule.cooldownSeconds) return;
    if (this.cooldowns.size >= COOLDOWN_SWEEP_THRESHOLD) {
      const now = Date.now();
      for (const [key, until] of this.cooldowns) {
        if (until <= now) this.cooldowns.delete(key);
      }
    }
    this.cooldowns.set(`${rule.id}:${chatId}`, Date.now() + rule.cooldownSeconds * 1000);
  }
}
