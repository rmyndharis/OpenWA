import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { dialectVariants } from '../../common/utils/chat-id-dialects';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { evaluateFilters } from '../webhook/filters/filter-evaluator';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
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
 * The reply is sent via the plugin message port (bound to `MessageService.sendText` by
 * MessageModule), which the module graph cannot inject directly: `MessageModule` imports
 * `SessionModule`, and this module is imported BY `SessionModule` (the projector calls
 * `evaluateInbound`), so a constructor dependency here would close a module cycle.
 * `ModuleRef.get(..., { strict: false })` resolves the core-owned token lazily at first use
 * instead. In unit contexts without a ModuleRef the evaluator logs and skips.
 */
@Injectable()
export class AutomationRulesService {
  private readonly logger = createLogger('AutomationRulesService');

  /** `${ruleId}:${chatId}` -> epoch ms until which the rule stays quiet in that chat. Per-process. */
  private readonly cooldowns = new Map<string, number>();

  private messagePort?: PluginMessagePort;

  constructor(
    @InjectRepository(AutomationRule, 'data')
    private readonly ruleRepository: Repository<AutomationRule>,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    private readonly configService?: ConfigService,
    // Last and @Optional() so the positional constructions in the unit spec keep compiling. Absent
    // means the chat-history gates cannot be honoured — see `passesHistoryGates`, which then
    // refuses to reply rather than replying past a gate the operator asked for.
    @Optional()
    @InjectRepository(Message, 'data')
    private readonly messageRepository?: Repository<Message>,
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
      newContactOnly: dto.newContactOnly ?? false,
      pauseOnHumanReply: dto.pauseOnHumanReply ?? false,
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
    if (dto.newContactOnly !== undefined) rule.newContactOnly = dto.newContactOnly;
    if (dto.pauseOnHumanReply !== undefined) rule.pauseOnHumanReply = dto.pauseOnHumanReply;
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
    const resolveLid = (jid: string): string | null => this.lidMappingStore?.resolveLid(jid) ?? null;

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

    // Chat-history gates run AFTER the cooldown pair, never between its check and its set: the two
    // are synchronous neighbours precisely so a burst collapses, and an await between them would
    // let the whole burst through. After is also the cheap side — one probe per cooldown window
    // instead of one per message — and costs nothing, because both gates are monotonic per chat
    // (history only grows), so a cooldown entered on a blocked evaluation can never suppress a
    // reply that would otherwise have been sent.
    if (!(await this.passesHistoryGates(rule, sessionId, chatId, message))) return;

    try {
      const messagePort = this.resolveMessagePort();
      if (!messagePort) return;
      // `automated: true` stamps `messages.automated` on the persisted row, which is what keeps a
      // `pauseOnHumanReply` rule from reading its own reply as the operator having answered.
      await messagePort.sendText(sessionId, { chatId, text: rule.replyText }, { automated: true });
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

  /**
   * The two chat-history gates. True means "this rule may reply".
   *
   * Both ask about the CHAT rather than the message, which is why they are rule fields and not
   * `conditions` entries: the filter registry resolves every field synchronously out of the message
   * payload, and neither question can be answered without reading `messages`.
   *
   * Fail-CLOSED, unlike the freshness gate above. The ambiguity is not symmetric here: replying
   * when the probe could not run means talking into a chat the operator explicitly fenced off —
   * greeting a customer who is mid-conversation, or cutting across a human who has taken the chat
   * over. Losing one autoreply to a transient DB fault is the cheaper mistake.
   */
  private async passesHistoryGates(
    rule: AutomationRule,
    sessionId: string,
    chatId: string,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    // The overwhelmingly common rule sets neither gate and must not pay a second round-trip per
    // inbound message: every session's rules are evaluated on every message (cap 32 per session).
    if (!rule.newContactOnly && !rule.pauseOnHumanReply) return true;

    const messages = this.messageRepository;
    if (!messages) {
      this.logger.warn('Automation rule declares a chat-history gate but no message repository is wired; skipping', {
        sessionId,
        ruleId: rule.id,
      });
      return false;
    }

    // Both probes read under both user-id spellings: inbound rows are neutralized to `@c.us` while
    // outbound rows keep the caller's raw form, so a byte-exact match would call a contact already
    // known as `@s.whatsapp.net` a stranger (and vice versa for the human-reply probe).
    const variants = dialectVariants(chatId);

    try {
      if (rule.newContactOnly) {
        // The projector commits the inbound row BEFORE dispatching to us, so the chat is never
        // empty at this point — the current message is in there and has to be excluded by its
        // engine id. Rows whose waMessageId is NULL (an engine that could not read the id back)
        // are real history and must still count, which `Not(...)` alone would drop: SQL `<>` is
        // never true against NULL.
        const waMessageId = typeof message.id === 'string' && message.id ? message.id : null;
        const priorHistory = await messages.exists({
          where: waMessageId
            ? variants.flatMap(id => [
                { sessionId, chatId: id, waMessageId: Not(waMessageId) },
                { sessionId, chatId: id, waMessageId: IsNull() },
              ])
            : // No engine id to exclude by. The current row (if it persisted) is indistinguishable
              // from prior history, so this reads as "known contact" and the greeting is skipped —
              // fail-closed, consistent with the rest of this gate.
              variants.map(id => ({ sessionId, chatId: id })),
        });
        if (priorHistory) return false;
      }

      if (rule.pauseOnHumanReply) {
        // Any outbound row the bot did not write: the operator's REST/bulk/template send, or a
        // message they composed on the linked phone (which reaches us as an own-send echo and is
        // persisted OUTGOING all the same). Rows predating the `automated` column read false,
        // which is correct — nothing wrote automated replies before it existed.
        const humanSent = await messages.exists({
          where: variants.map(id => ({
            sessionId,
            chatId: id,
            direction: MessageDirection.OUTGOING,
            automated: false,
          })),
        });
        if (humanSent) return false;
      }
    } catch (error) {
      this.logger.warn('Automation rule chat-history probe failed; not replying', {
        sessionId,
        ruleId: rule.id,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    return true;
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) {
      try {
        // The core-owned port token, resolved lazily — never a static import of MessageService: a
        // value-import here closes the file cycle session (projector) -> automation -> message ->
        // session, and whichever class evaluates last in that cycle is `undefined` while Nest builds
        // the graph. By reply time every module is loaded, so resolving the token lazily sidesteps
        // the cycle entirely.
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, PluginMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch (error) {
        this.logger.warn('MessageService is not resolvable; automation replies are disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }
    return this.messagePort;
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
