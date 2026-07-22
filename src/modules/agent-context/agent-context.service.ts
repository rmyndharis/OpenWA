import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { canonicalIdentity, CanonicalIdentity } from '../../engine/identity/canonical-identity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageQuote } from '../message/entities/message-quote.entity';
import { MessageReaction } from '../message/entities/message-reaction.entity';

/** Hard request/data cap; no caller-controlled pagination is accepted by this surface. */
export const AGENT_CONTEXT_RECENT_LIMIT = 6;
/** Per-message cap prevents a single long message from becoming an unbounded prompt input. */
export const AGENT_CONTEXT_BODY_MAX_CHARS = 1000;
/** Each projected message reads at most this many current reactions. */
export const AGENT_CONTEXT_REACTIONS_PER_MESSAGE_LIMIT = 16;
/** Raw JID aliases are cache-derived and capped so identity bridging cannot widen a context read. */
export const AGENT_CONTEXT_CHAT_BUCKET_LIMIT = 32;

const MESSAGE_PROJECTION_COLUMNS = [
  'id',
  'sessionId',
  'chatId',
  'from',
  'body',
  'type',
  'direction',
  'timestamp',
  'status',
  'createdAt',
] as const;

export interface AgentContextMessage {
  id: string;
  canonicalChat: CanonicalIdentity;
  sender: CanonicalIdentity;
  direction: MessageDirection;
  type: string;
  body?: string;
  occurredAt: string;
  /** Aggregate persisted status, never a fabricated per-recipient receipt. */
  receipt: { status: MessageStatus };
  quote?: { messageId: string; body?: string };
  reactions?: Array<{ sender: CanonicalIdentity; emoji: string }>;
}

export interface AgentContextV1 {
  schema: 'openwa.agent-context.v1';
  session: { id: string };
  message: AgentContextMessage;
  /** The newest six persisted messages in the same session and canonical raw chat bucket. */
  conversation: AgentContextMessage[];
}

function boundedBody(body: string | null | undefined): string | undefined {
  if (body == null) return undefined;
  return body.slice(0, AGENT_CONTEXT_BODY_MAX_CHARS);
}

function occurredAt(message: Pick<Message, 'timestamp' | 'createdAt'>): Date {
  // WhatsApp time is the event time. createdAt is an arrival/persistence timestamp and is used only
  // for old rows for which the engine did not provide a timestamp.
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp * 1000);
  }
  return message.createdAt;
}

/**
 * Read-only, intentionally narrow context projection for an explicitly selected inbound message.
 *
 * It has no dependency on MessageService (which also owns send operations), no arbitrary list/search
 * API, no metadata/media projection, and no caller-controlled history size. The feature module that
 * mounts its controller is opt-in; this service only exists to make its narrow data boundary explicit.
 */
@Injectable()
export class AgentContextService {
  constructor(
    @InjectRepository(Message, 'data')
    private readonly messages: Repository<Message>,
    private readonly lidMappings: LidMappingStoreService,
    @InjectRepository(MessageQuote, 'data')
    private readonly quotes: Repository<MessageQuote>,
    @InjectRepository(MessageReaction, 'data')
    private readonly reactions: Repository<MessageReaction>,
  ) {}

  async getMessageContext(sessionId: string, messageId: string): Promise<AgentContextV1> {
    // Scope the primary lookup by session as well as id, so a valid id from another session has the
    // same result as a missing id. The API key guard independently enforces allowedSessions.
    const message = await this.messages.findOne({
      where: { id: messageId, sessionId },
      // Do not fetch `metadata`: it can contain raw media and adapter-specific fields. Every selected
      // column below is either directly projected or needed only for the bounded event-time cutoff.
      select: [...MESSAGE_PROJECTION_COLUMNS],
    });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    // Requiring a selected inbound trigger keeps this from degrading into a generic historical message
    // reader. It also makes the returned `message` an unambiguous agent input, not an outbound draft.
    if (message.direction !== MessageDirection.INCOMING) {
      throw new BadRequestException('Agent context is available only for incoming messages');
    }

    // This is the only message-history read. It is bounded at (and includes) the selected inbound
    // trigger, so a late agent invocation never sees messages that happened afterward. `timestamp` is
    // WhatsApp event time; createdAt is used only where timestamp is absent. WhatsApp timestamps have
    // second granularity, so no UUID can safely establish same-second event order: include only the
    // exact trigger at its second and prefer omitting ambiguous siblings over leaking a later event.
    const triggerTime = occurredAt(message).getTime() / 1000;
    const chatIds = this.historyChatBucket(message.chatId);
    const eventTimeSql = this.eventTimeSql('message');
    const recent = await this.messages
      .createQueryBuilder('message')
      .select(MESSAGE_PROJECTION_COLUMNS.map(column => `message.${column}`))
      .where('message.sessionId = :sessionId', { sessionId })
      .andWhere('message.chatId IN (:...chatIds)', { chatIds })
      .andWhere(`(${eventTimeSql} < :triggerTime OR message.id = :triggerId)`, {
        triggerTime,
        triggerId: message.id,
      })
      .orderBy(eventTimeSql, 'DESC')
      .addOrderBy('message.id', 'DESC')
      .take(AGENT_CONTEXT_RECENT_LIMIT)
      .getMany();

    const projectionMessages = [message, ...recent.filter(item => item.id !== message.id)];
    const quotesByMessage = await this.loadQuotes(
      sessionId,
      projectionMessages.map(item => item.id),
    );
    const reactionsByMessage = await this.loadReactions(
      sessionId,
      projectionMessages.map(item => item.id),
    );

    return {
      schema: 'openwa.agent-context.v1',
      session: { id: sessionId },
      message: this.project(message, quotesByMessage.get(message.id), reactionsByMessage.get(message.id)),
      // `take` bounds every supported TypeORM backend. Slice as well so this public projection
      // remains bounded even if a future repository wrapper/mocked adapter ignores that hint.
      conversation: recent
        .slice(0, AGENT_CONTEXT_RECENT_LIMIT)
        .map(item => this.project(item, quotesByMessage.get(item.id), reactionsByMessage.get(item.id))),
    };
  }

  private eventTimeSql(alias: string): string {
    // PostgreSQL and SQLite are the supported data stores. The query uses the same numeric epoch for
    // both timestamp-bearing and legacy rows so ordering/cutoff cannot accidentally depend on DB arrival.
    const type = this.messages.manager.connection.options.type;
    if (type === 'postgres') {
      return `COALESCE("${alias}"."timestamp", EXTRACT(EPOCH FROM "${alias}"."createdAt"))`;
    }
    return `COALESCE("${alias}"."timestamp", CAST(strftime('%s', "${alias}"."createdAt") AS INTEGER))`;
  }

  /**
   * Return only the raw chat id plus aliases proven by the in-memory LID mapping cache. A LID without
   * a cached phone mapping stays in a one-item bucket; no network/database lookup or guessed phone is
   * permitted from this read path.
   */
  private historyChatBucket(chatId: string): string[] {
    const bucket = new Set<string>([chatId]);
    const identity = canonicalIdentity(chatId, this.lidMappings);
    if (identity.kind !== 'person' || identity.resolution !== 'phone-resolved') {
      return [...bucket];
    }

    const phone = identity.canonicalJid.slice(0, identity.canonicalJid.indexOf('@'));
    // Persisted history can contain either adapter's direct-user dialect. Both identify the same
    // resolved phone, while the original raw id remains present for exact backwards compatibility.
    bucket.add(`${phone}@c.us`);
    bucket.add(`${phone}@s.whatsapp.net`);
    for (const lid of this.lidMappings.lidsForPhone(phone)) {
      if (bucket.size >= AGENT_CONTEXT_CHAT_BUCKET_LIMIT) break;
      if (lid) bucket.add(`${lid}@lid`);
    }
    return [...bucket];
  }

  private async loadQuotes(sessionId: string, messageIds: string[]): Promise<Map<string, MessageQuote>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.quotes.find({
      where: messageIds.map(messageId => ({ sessionId, messageId })),
      select: ['messageId', 'quotedWaMessageId', 'body'],
    });
    return new Map(rows.map(row => [row.messageId, row]));
  }

  private async loadReactions(sessionId: string, messageIds: string[]): Promise<Map<string, MessageReaction[]>> {
    const entries = await Promise.all(
      messageIds.map(async messageId => {
        const rows = await this.reactions.find({
          where: { sessionId, messageId },
          select: ['messageId', 'senderId', 'emoji'],
          order: { senderId: 'ASC' },
          take: AGENT_CONTEXT_REACTIONS_PER_MESSAGE_LIMIT,
        });
        return [messageId, rows] as const;
      }),
    );
    return new Map(entries);
  }

  private project(message: Message, quote?: MessageQuote, reactions: MessageReaction[] = []): AgentContextMessage {
    const body = boundedBody(message.body);
    const quoteBody = quote && boundedBody(quote.body);
    const safeReactions = reactions
      .filter(reaction => reaction.senderId.length > 0 && reaction.emoji.length > 0)
      .map(reaction => ({
        sender: canonicalIdentity(reaction.senderId, this.lidMappings),
        emoji: reaction.emoji.slice(0, 64),
      }));
    return {
      id: message.id,
      canonicalChat: canonicalIdentity(message.chatId, this.lidMappings),
      sender: canonicalIdentity(message.from, this.lidMappings),
      direction: message.direction,
      type: message.type,
      ...(body !== undefined ? { body } : {}),
      occurredAt: occurredAt(message).toISOString(),
      receipt: { status: message.status },
      ...(quote
        ? { quote: { messageId: quote.quotedWaMessageId, ...(quoteBody !== undefined ? { body: quoteBody } : {}) } }
        : {}),
      ...(safeReactions.length > 0 ? { reactions: safeReactions } : {}),
    };
  }
}
