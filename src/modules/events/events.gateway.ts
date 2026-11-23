import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  ForbiddenException,
  Inject,
  OnModuleDestroy,
  Optional,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { createLogger } from '../../common/services/logger.service';
import { getRequestActor, runWithRequestId } from '../../common/services/request-context';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { BrowserSessionService } from '../auth/browser-session.service';
import { BrowserSession } from '../auth/entities/browser-session.entity';
import { allowUnauthenticatedAuditRow } from '../audit/auth-failure-audit-limiter';
import {
  extractBrowserSessionCookie,
  firstHeaderValue,
  isAllowedBrowserWsHandshake,
  type CookieRequestLike,
} from '../auth/browser-session.util';
import { ChatScopeService } from '../auth/chat-scope.service';
import { isWsRedisEnabled } from './redis-io.adapter';
import { WS_RESTRICTED_PRESENCE_TRACKER, WsRestrictedPresenceTracker } from './ws-restricted-presence';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { parseWaId, userPart } from '../../engine/identity/wa-id';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { resolveCorsPolicy } from '../../config/bootstrap-security';
import {
  limiterKeyForIp,
  parseTrustedProxies,
  resolveClientIp as resolveRequestClientIp,
  type RequestLike,
} from '../../common/utils/ip';
import { DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES, shedInlineMedia } from '../../common/utils/inline-media';
import { isSafeSessionName } from '../../common/utils/path-safety';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import { apiKeyAuthorizationFingerprint, apiKeyExpiryTime } from '../auth/api-key-authorization';
import {
  readWsRateLimitConfig,
  TokenBucketLimiter,
  SlidingWindowLimiter,
  type WsRateLimitConfig,
} from './ws-rate-limit';

/**
 * WebSocket CORS policy: reuse the HTTP CORS policy instead of a hardcoded '*'.
 * Dev -> allow any origin (without credentials); explicit CORS_ORIGINS -> allowlist with credentials.
 * Read from process.env at module load (real env vars apply; same-origin is unaffected).
 */
function resolveWsCorsConfig(): { origin: boolean | string[]; credentials: boolean } {
  const policy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  return {
    origin: policy.allowAnyOrigin ? true : policy.origins,
    credentials: policy.credentials,
  };
}

/**
 * Read TRUSTED_PROXIES once as a list — mirrors mcp.server.ts so the WS surface resolves the
 * client IP with the same trusted-proxy-aware logic as the REST guard and the MCP mount.
 */
function readTrustedProxies(): string[] {
  return parseTrustedProxies(process.env.TRUSTED_PROXIES);
}
import type {
  WSClientMessage,
  WSSubscribeRequest,
  WSUnsubscribeRequest,
  WSSubscribedResponse,
  WSUnsubscribedResponse,
  WSEventMessage,
  WSErrorResponse,
  WSPongResponse,
} from './dto/ws-messages.dto';
import { SUBSCRIBABLE_EVENTS, buildRoomName } from './dto/ws-messages.dto';
import type { DeliveryStatus, MessageReceiptStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { WILDCARD_EXCLUDED_EVENTS } from '../../common/utils/wildcard-events';

// The events a chat-restricted key may receive, each delivered only for a chat inside its allowlist.
// group.join_request is not one of them: it names the people asking to join, who are outside the
// allowed chats by definition, and the REST membership-request routes refuse these keys for that reason.
const CHAT_EVENTS = new Set([
  'message.received',
  'message.sent',
  'message.ack',
  'message.receipt',
  'message.revoked',
  'message.reaction',
  'message.edited',
  'group.join',
  'group.leave',
  'group.update',
  'presence.update',
  'event.response',
  'poll.vote',
]);

/**
 * The frame with a `requestId` that is not a short string dropped. A reply that carried client JSON back
 * made the transport serialize whatever structure the client nested in it, which is not the client's to
 * choose; the handlers below then never see anything but a string or nothing.
 */
function withSafeRequestId(message: WSClientMessage | null | undefined): WSClientMessage | null | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
  const { requestId } = message as { requestId?: unknown };
  if (requestId === undefined) return message;
  if (typeof requestId === 'string' && requestId.length <= MAX_REQUEST_ID_LENGTH) return message;
  return { ...message, requestId: undefined };
}

function chatRoom(sessionId: string, event: string, chatId: string): string {
  return `${buildRoomName(sessionId, event)}:chat:${encodeURIComponent(chatId)}`;
}

/**
 * Whether an API key may subscribe to a session's WebSocket event rooms.
 * An unrestricted key (no `allowedSessions`) may subscribe to anything, including
 * the `*` wildcard. A key scoped to specific sessions may NOT subscribe to `*`
 * (which would receive every session's events) nor to a session outside its
 * allowlist — preventing cross-tenant event leakage (#221).
 */
export function isSessionSubscriptionAllowed(allowedSessions: string[] | null | undefined, sessionId: string): boolean {
  if (!allowedSessions || allowedSessions.length === 0) {
    return true;
  }
  if (sessionId === '*') {
    return false;
  }
  return allowedSessions.includes(sessionId);
}

/**
 * Room holding every socket whose key may NOT read a session's pairing QR over REST
 * (`GET /sessions/:sessionId/qr` requires OPERATOR). `session.qr` is broadcast with this room
 * excluded, which covers the explicit event name and both wildcard subscribe forms. Membership is
 * set from the re-validated key on every subscribe, before any subscription room is joined, so a
 * socket can never hold a subscription room without it.
 */
export const QR_DENIED_ROOM = 'role:qr-denied';

/** Roles allowed to receive `session.qr`. Anything else, including an unknown role, is denied. */
const QR_ALLOWED_ROLES: ReadonlySet<string> = new Set([ApiKeyRole.OPERATOR, ApiKeyRole.ADMIN]);

/**
 * Subscription rooms live until the socket disconnects, so their names and count are bounded: a session
 * id is a uuid (any id the engines accept is isSafeSessionName), and one socket holds at most this many
 * subscription rooms, far above every event of every session a client would follow.
 */
const MAX_SUBSCRIBE_SESSION_ID_LENGTH = 128;
// A request id only correlates a reply with its request, so only a short string is ever echoed back.
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ROOMS_PER_SOCKET = 4096;
const TOO_MANY_SUBSCRIPTIONS_MESSAGE = `A connection may hold at most ${MAX_ROOMS_PER_SOCKET} subscriptions; unsubscribe first`;

/** `*` or a session id: all a subscription room, and a reply that names one, may carry. */
function isSessionSelector(sessionId: string): boolean {
  return sessionId === '*' || (sessionId.length <= MAX_SUBSCRIBE_SESSION_ID_LENGTH && isSafeSessionName(sessionId));
}

/**
 * Whether validateApiKey judged the credential (unknown, revoked, expired, IP- or session-refused), as opposed to
 * failing to read it. Only a judgement is an authentication failure; the REST guard lets anything else through
 * as a 500.
 */
function isKeyRefusal(error: unknown): boolean {
  return error instanceof UnauthorizedException || error instanceof ForbiddenException;
}

const KEY_UNREADABLE_MESSAGE = 'The API key could not be checked; retry shortly';

/** Why an API key's live WebSocket sockets are being torn down — drives the client-facing message. */
export type ApiKeyEvictionReason = 'revoked' | 'deleted' | 'authorization_changed' | 'expired';

const EVICTION_MESSAGES: Record<ApiKeyEvictionReason, string> = {
  revoked: 'API key has been revoked',
  deleted: 'API key has been deleted',
  authorization_changed: 'API key authorization changed; please reconnect',
  expired: 'API key has expired',
};

/** Why a browser session's live WebSocket sockets are being torn down. */
export type BrowserSessionEvictionReason = 'logged_out' | 'revoked' | 'expired';

const BROWSER_SESSION_EVICTION_MESSAGES: Record<BrowserSessionEvictionReason, string> = {
  logged_out: 'Session has been logged out',
  revoked: 'Session has been revoked',
  expired: 'Session has expired',
};

/**
 * Largest client frame the socket accepts, in bytes. A client only sends subscribe, unsubscribe and ping
 * frames, and the longest legal one (the longest session and request id, every event) is under 1 KB.
 * Every frame is decoded and walked before it is answered, so the Socket.IO default of 1 MB is far more
 * than any client needs.
 */
export const WS_MAX_FRAME_BYTES = 8 * 1024;

/**
 * How long the lid table's answer for a chat is reused, both for mapped chats and as a short negative
 * cache for unmapped 1:1 chats, so bursts of events for one chat hit the table once. Newly persisted
 * mappings immediately evict stale entries via LidMappingStoreService.onMappingLearned for both the
 * LID and phone JID. A mapping learned on another node arrives up to this long late, and after a
 * mapping is removed or moved, events of the chat keep reaching sockets restricted to the old identity
 * for up to this long.
 */
export const CHAT_IDS_MEMO_TTL_MS = 5_000;
/** Most chats the answers are kept for; the oldest go first. */
export const CHAT_IDS_MEMO_MAX = 1_000;
/** Maximum queued chat-room fan-out deliveries retained per chat before dropping oldest excess. */
const MAX_CHAT_DELIVERIES_PER_CHAT = 64;
/** Total queued fan-out deliveries retained per session across all chats. */
const MAX_CHAT_DELIVERIES_PER_SESSION = 1_024;
const CHAT_DELIVERY_DROP_WARN_INTERVAL_MS = 60_000;
const CHAT_DELIVERY_DROP_WARN_MAX = 1_000;

interface PendingChatDelivery {
  event: string;
  chatId: string;
  sessionId: string;
  eventMessage: WSEventMessage;
  idsPromise: Promise<string[] | undefined>;
}

@WebSocketGateway({
  cors: resolveWsCorsConfig(),
  namespace: '/events',
  maxHttpBufferSize: WS_MAX_FRAME_BYTES,
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private logger = createLogger('EventsGateway');

  /**
   * Active sockets keyed by their validating API-key id, so a key revoked/disabled
   * mid-connection can have its live subscriptions torn down immediately (otherwise
   * an already-subscribed socket keeps receiving events until it happens to disconnect).
   */
  private readonly socketsByKeyId = new Map<string, Set<Socket>>();
  private readonly socketsByBrowserSessionId = new Map<string, Set<Socket>>();
  private readonly chatDeliveries = new Map<string, PendingChatDelivery[]>();
  private readonly chatDeliveryActive = new Set<string>();
  private readonly chatDeliveryDropWarn = new Map<string, { at: number; dropped: number }>();
  private destroyed = false;
  // The identities of a chat as the lid table gives them, by session and chat. See chatIds.
  private readonly chatIdsMemo = new Map<string, { ids: Promise<string[] | undefined>; expiresAt: number }>();
  // Subscribes still re-validating their key. An unsubscribe answered meanwhile cancels the ones it covers, so
  // they cannot join rooms after the client was told they were left.
  private readonly pendingSubscriptions = new WeakMap<Socket, Set<{ sessionId: string; cancelled: boolean }>>();
  private authzSweepTimer?: ReturnType<typeof setInterval>;
  private unsubscribeMappingLearned?: () => void;

  /**
   * Rate limiting for the WS surface (see ws-rate-limit.ts). Frames never pass through the
   * Nest guard pipeline, so these run in the gateway itself:
   *  - frameLimiter: per-key token bucket on every inbound client frame (pre-auth sockets are
   *    keyed by IP instead, since they have no validated key yet);
   *  - handshakeLimiter: pre-auth per-IP sliding window on new connections, so a handshake
   *    flood cannot force a DB validateApiKey per attempt;
   *  - maxSocketsPerKey: cap on simultaneous sockets per key, enforced at connect.
   */
  private readonly rateLimits: WsRateLimitConfig;
  private readonly frameLimiter: TokenBucketLimiter;
  private readonly handshakeLimiter: SlidingWindowLimiter;

  /**
   * Rate-limit violation sampler: at most one audit row per kind+subject per minute. An abuser
   * held at a limit would otherwise generate an audit write per blocked frame/handshake — the
   * audit trail itself becoming the flood. `count` accumulates the suppressed violations since
   * the last emitted row and is folded into the next one.
   */
  private readonly violations = new Map<string, { count: number; since: number }>();
  private static readonly VIOLATION_AUDIT_WINDOW_MS = 60_000;
  private static readonly MAX_VIOLATION_KEYS = 10_000;

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly chatScope: ChatScopeService = new ChatScopeService(),
    @Optional()
    @Inject(forwardRef(() => BrowserSessionService))
    private readonly browserSessionService?: BrowserSessionService,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    @Inject(WS_RESTRICTED_PRESENCE_TRACKER)
    private restrictedPresence?: WsRestrictedPresenceTracker,
    @Optional()
    @InjectDataSource('main')
    private readonly mainDataSource?: DataSource,
  ) {
    this.rateLimits = readWsRateLimitConfig();
    this.frameLimiter = new TokenBucketLimiter(this.rateLimits.framePerSecond, this.rateLimits.frameBurst);
    this.handshakeLimiter = new SlidingWindowLimiter(this.rateLimits.handshakeMax, this.rateLimits.handshakeWindowMs);
    const onLearned = ({ lid, phone }: { lid: string; phone: string }) => {
      const lidUser = userPart(lid.trim());
      const phoneUser = userPart(phone.trim());
      if (lidUser) this.invalidateChatIdsMemo(`${lidUser}@lid`);
      if (phoneUser) this.invalidateChatIdsMemo(`${phoneUser}@c.us`);
    };
    this.unsubscribeMappingLearned =
      this.lidMappingStore?.onMappingLearned?.(onLearned) ?? this.chatScope.onMappingLearned?.(onLearned);
    this.restrictedPresence?.bindLocalCheck(() => this.hasLocalRestrictedSocket());
  }

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
    this.authzSweepTimer = setInterval(() => {
      void this.sweepApiKeyAuthorization().catch(error =>
        this.logger.error(
          'Failed to sweep WebSocket API key authorization',
          error instanceof Error ? error.stack : error,
        ),
      );
    }, 60_000);
    this.authzSweepTimer.unref?.();
    if (!this.restrictedPresence && isWsRedisEnabled()) {
      const nodeId = this.configService.get<string>('session.nodeId') || process.env.NODE_ID || hostname();
      this.restrictedPresence = WsRestrictedPresenceTracker.createDefault(nodeId, () =>
        this.hasLocalRestrictedSocket(),
      );
    }
    this.restrictedPresence?.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.authzSweepTimer) clearInterval(this.authzSweepTimer);
    this.authzSweepTimer = undefined;
    this.unsubscribeMappingLearned?.();
    this.unsubscribeMappingLearned = undefined;
    this.chatDeliveries.clear();
    this.chatDeliveryActive.clear();
    this.chatDeliveryDropWarn.clear();
    await this.restrictedPresence?.destroy();
  }

  /**
   * Re-validate the keys behind the live sockets against the database, once per tick.
   *
   * A socket carries the key snapshot taken at connect and never refreshes it, so every later change
   * to the row is invisible to it: a key deleted, revoked, expired or narrowed by a direct write to
   * this node's main database, or by an operator change that committed in the window between this
   * socket's validation and its registration here. The operator path still evicts synchronously in
   * the same request (see AuthService.update/revoke/delete); this is the backstop for the changes
   * that never reached this process.
   *
   * One batched read over the distinct key ids currently holding sockets, then eviction per key with
   * the reason that actually applies. Only the authorization columns are compared (see
   * apiKeyAuthorizationFingerprint), so the usage tracker's windowed lastUsedAt/usageCount write,
   * which touches every key in use, evicts nobody.
   */
  private async sweepApiKeyAuthorization(now = Date.now()): Promise<void> {
    // The expiry a socket already carries is decided first, and without the database: it needs no row
    // to be read, and a table that is unreachable or locked must not keep an expired key streaming
    // events until the first tick whose read succeeds.
    for (const [keyId, sockets] of Array.from(this.socketsByKeyId.entries())) {
      if (Array.from(sockets).some(client => this.isSnapshotExpired(client, now))) {
        this.evictApiKey(keyId, 'expired');
      }
    }
    const keyIds = Array.from(this.socketsByKeyId.keys());
    if (keyIds.length > 0) {
      try {
        const current = await this.authService.findAuthorizationStates(keyIds);
        const byId = new Map(current.map(key => [key.id, key]));
        for (const keyId of keyIds) {
          const reason = this.evictionReason(byId.get(keyId), this.socketsByKeyId.get(keyId), now);
          if (reason) this.evictApiKey(keyId, reason);
        }
      } catch (error) {
        this.logger.error(
          'Failed to sweep WebSocket API key authorization',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    if (this.socketsByBrowserSessionId.size > 0) {
      // Enforce stored browser-session expiry offline before hitting the DB, independent of API-key sweep errors.
      for (const [browserSessionId, sockets] of Array.from(this.socketsByBrowserSessionId.entries())) {
        if (Array.from(sockets).some(client => this.isBrowserSessionExpired(client, now))) {
          this.evictBrowserSession(browserSessionId, 'expired');
        }
      }
    }
    const sessionIds = Array.from(this.socketsByBrowserSessionId.keys());
    if (sessionIds.length > 0) {
      if (this.mainDataSource) {
        try {
          const rows = await this.mainDataSource.getRepository(BrowserSession).findBy({ id: In(sessionIds) });
          const bySessionId = new Map(rows.map(row => [row.id, row]));
          for (const browserSessionId of sessionIds) {
            const row = bySessionId.get(browserSessionId);
            if (!row || row.revokedAt !== null) {
              this.evictBrowserSession(browserSessionId, 'revoked');
              continue;
            }
            const expiry = apiKeyExpiryTime(row.expiresAt);
            if (expiry !== null && expiry <= now) {
              this.evictBrowserSession(browserSessionId, 'expired');
            }
          }
        } catch (error) {
          this.logger.error(
            'Failed to batch-sweep WebSocket browser sessions',
            error instanceof Error ? error.stack : String(error),
          );
        }
      } else if (this.browserSessionService) {
        for (const browserSessionId of sessionIds) {
          const sockets = this.socketsByBrowserSessionId.get(browserSessionId);
          const sampleSocket = sockets?.values().next().value;
          if (!sampleSocket) continue;
          const clientIp = this.resolveClientIp(sampleSocket);
          try {
            await this.browserSessionService.validateSessionById(browserSessionId, clientIp, undefined, {
              recordUsage: false,
            });
          } catch (error) {
            if (isKeyRefusal(error)) {
              const msg = error instanceof Error ? error.message.toLowerCase() : '';
              const reason: BrowserSessionEvictionReason = msg.includes('expired') ? 'expired' : 'revoked';
              this.evictBrowserSession(browserSessionId, reason);
            } else {
              this.logger.error(
                `Failed to re-validate browser session ${browserSessionId} during WebSocket sweep`,
                error instanceof Error ? error.stack : String(error),
              );
            }
          }
        }
      }
    }
  }

  /**
   * Why a key's sockets must go, or null to keep them. `current` is the row as it stands now, absent
   * when the key was deleted. Order matters: the reason a client is told should be the strongest one
   * that applies, not merely the first field that differs from its snapshot.
   */
  private evictionReason(
    current: ApiKey | undefined,
    sockets: Set<Socket> | undefined,
    now: number,
  ): ApiKeyEvictionReason | null {
    if (!sockets || sockets.size === 0) return null;
    if (!current) return 'deleted';
    if (!current.isActive) return 'revoked';
    const expiry = apiKeyExpiryTime(current.expiresAt);
    // An expiry that does not parse is the epoch for apiKeyExpiryTime, so it is expired here as AuthService refuses it.
    if (expiry !== null && expiry <= now) return 'expired';
    const authorization = apiKeyAuthorizationFingerprint(current);
    // Per socket, not per key: sockets under one key connected at different moments, so one can hold
    // a stale snapshot while another already carries the new authorization. A socket that subscribed
    // under something other than its snapshot goes too, even when the row matches that snapshot
    // again: the rooms that subscribe granted are never revisited, so a widening reverted before this
    // tick would otherwise leave them joined for the life of the connection.
    const stale = Array.from(sockets).some(
      client => this.snapshotFingerprint(client) !== authorization || this.hasDivergentGrant(client),
    );
    return stale ? 'authorization_changed' : null;
  }

  /** The authorization fingerprint of the key snapshot a socket has been carrying since connect. */
  private snapshotFingerprint(client: Socket): string {
    const snapshot = (client.data as { apiKey?: ApiKey } | undefined)?.apiKey;
    return snapshot ? apiKeyAuthorizationFingerprint(snapshot) : '';
  }

  /** Whether the key snapshot a socket carries has expired, decided from the socket alone. */
  private isSnapshotExpired(client: Socket, now: number): boolean {
    const snapshot = (client.data as { apiKey?: Pick<ApiKey, 'expiresAt'> } | undefined)?.apiKey;
    const expiry = apiKeyExpiryTime(snapshot?.expiresAt);
    return expiry !== null && expiry <= now;
  }

  /** Whether the browser session expiry a cookie socket carries has lapsed, decided without DB access. */
  private isBrowserSessionExpired(client: Socket, now: number): boolean {
    const expiresAt = (client.data as { browserSessionExpiresAt?: Date | string | null } | undefined)
      ?.browserSessionExpiresAt;
    if (expiresAt === undefined || expiresAt === null) return false;
    const expiry = apiKeyExpiryTime(expiresAt);
    return expiry !== null && expiry <= now;
  }

  /** Whether a subscribe ever granted this socket something under a key other than its snapshot. */
  private hasDivergentGrant(client: Socket): boolean {
    return (client.data as { authorizationDiverged?: boolean } | undefined)?.authorizationDiverged === true;
  }

  /**
   * Resolve the trusted-proxy-aware client IP for a socket, reusing the same shared
   * `resolveClientIp` helper as the REST guard and MCP mount. X-Forwarded-For is only
   * honored when the immediate peer is a configured trusted proxy, preventing IP-spoofing
   * of the allowedIps allowlist over the WS surface.
   */
  private resolveClientIp(client: Socket): string {
    const handshake = client.handshake;
    const req: RequestLike = {
      ip: handshake.address,
      socket: { remoteAddress: handshake.address },
      headers: handshake.headers ?? {},
    };
    return resolveRequestClientIp(req, readTrustedProxies());
  }

  private trackSocket(keyId: string, client: Socket, browserSessionId?: string): void {
    let sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByKeyId.set(keyId, sockets);
    }
    sockets.add(client);

    if (browserSessionId) {
      let sessionSockets = this.socketsByBrowserSessionId.get(browserSessionId);
      if (!sessionSockets) {
        sessionSockets = new Set();
        this.socketsByBrowserSessionId.set(browserSessionId, sessionSockets);
      }
      sessionSockets.add(client);
    }
  }

  private untrackKeySocket(client: Socket): void {
    const keyId = (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id;
    if (!keyId) return;
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) return;
    sockets.delete(client);
    if (sockets.size === 0) {
      this.socketsByKeyId.delete(keyId);
    }
  }

  private untrackBrowserSessionSocket(client: Socket): void {
    const browserSessionId = (client.data as { browserSessionId?: string } | undefined)?.browserSessionId;
    if (!browserSessionId) return;
    const sessionSockets = this.socketsByBrowserSessionId.get(browserSessionId);
    if (!sessionSockets) return;
    sessionSockets.delete(client);
    if (sessionSockets.size === 0) {
      this.socketsByBrowserSessionId.delete(browserSessionId);
    }
  }

  private hasLocalRestrictedSocket(): boolean {
    return Array.from(this.socketsByKeyId.values()).some(sockets =>
      Array.from(sockets).some(client => this.chatScope.isRestricted((client.data as { apiKey?: ApiKey }).apiKey)),
    );
  }

  private syncRestrictedPresence(): Promise<void> {
    if (!this.restrictedPresence || !isWsRedisEnabled()) return Promise.resolve();
    return this.restrictedPresence.syncLocal(this.hasLocalRestrictedSocket());
  }

  private untrackSocket(client: Socket): void {
    this.untrackKeySocket(client);
    this.untrackBrowserSessionSocket(client);
    void this.syncRestrictedPresence();
  }

  /**
   * Tear down every active socket authenticated with `keyId`. Called by AuthService when a key is
   * revoked, deleted, or has its authorization (role/allowedSessions/allowedChats/allowedIps/expiry) narrowed, and
   * by sweepApiKeyAuthorization for the same changes when they only reach this process through the
   * database, so the key's already-subscribed sockets stop receiving events immediately instead of
   * lingering until they disconnect on their own. Each socket gets a clean close (an `UNAUTHORIZED`
   * reason) reflecting the actual trigger, rather than a silent drop.
   */
  evictApiKey(keyId: string, reason: ApiKeyEvictionReason = 'revoked'): void {
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets || sockets.size === 0) return;
    this.logger.log(`Evicting ${sockets.size} WebSocket connection(s) (${reason}) for key ${keyId}`);
    this.socketsByKeyId.delete(keyId);
    const message = EVICTION_MESSAGES[reason];
    for (const client of sockets) {
      this.untrackBrowserSessionSocket(client);
      client.emit('message', this.createError('UNAUTHORIZED', message));
      client.disconnect(true);
    }
    void this.syncRestrictedPresence();
  }

  /**
   * Tear down every active socket authenticated with a specific browser session id (logout, revoke,
   * or expiry).
   */
  evictBrowserSession(browserSessionId: string, reason: BrowserSessionEvictionReason = 'logged_out'): void {
    const sockets = this.socketsByBrowserSessionId.get(browserSessionId);
    if (!sockets || sockets.size === 0) return;
    this.logger.log(
      `Evicting ${sockets.size} WebSocket connection(s) (${reason}) for browser session ${browserSessionId}`,
    );
    this.socketsByBrowserSessionId.delete(browserSessionId);
    const message = BROWSER_SESSION_EVICTION_MESSAGES[reason];
    for (const client of sockets) {
      this.untrackKeySocket(client);
      client.emit('message', this.createError('UNAUTHORIZED', message));
      client.disconnect(true);
    }
    void this.syncRestrictedPresence();
  }

  handleConnection(client: Socket): Promise<void> {
    // socket.io sends CONNECT to the client before Nest calls this, and Nest binds the frame handlers
    // without waiting for it, so a client that subscribes from its 'connect' handler can send a frame
    // while the key below is still being validated. handleMessage waits on this promise; it is stored
    // synchronously, before any frame can be dispatched.
    const ready = this.authenticate(client);
    (client.data as { authReady?: Promise<void> }).authReady = ready;
    return ready;
  }

  private async authenticate(client: Socket): Promise<void> {
    // Resolve the client IP once here so the handshake throttle, the validation, and the
    // audit trail all use the same trusted-proxy-aware value (parity with the REST guard / MCP mount).
    const clientIp = this.resolveClientIp(client);
    // The handshake bucket key: an IPv6 client is charged on its /64. The refund below must name the
    // same bucket, or an authenticated IPv6 handshake is never given back.
    const handshakeKey = limiterKeyForIp(clientIp);

    // Pre-auth, per-IP handshake throttle. This must run BEFORE any credential handling: an
    // unauthenticated handshake flood otherwise reaches the DB validateApiKey below on every
    // attempt (same gap the MCP pre-auth IP throttle covers for the /mcp mount).
    const handshakeReservation = {};
    if (!this.handshakeLimiter.allow(handshakeKey, handshakeReservation)) {
      this.logger.warn(`Client ${client.id} rejected: handshake rate limit exceeded (ip: ${clientIp})`);
      this.noteRateLimitViolation('handshake', { ipAddress: clientIp });
      client.emit('message', this.createError('RATE_LIMITED', 'Too many connection attempts, retry later'));
      // Closing the transport too: Socket.IO cleared its connect timeout when it accepted the namespace, so a
      // namespace-only disconnect would leave the connection open for as long as the peer answers pings.
      client.disconnect(true);
      return;
    }

    // Accept the key only via Socket.IO's `auth` field or the header — never the query string, which
    // leaks the credential into proxy/access logs. (The deprecated `?apiKey=` fallback was removed.)
    // A non-string `auth.apiKey` counts as absent, so it is refused as a missing key, not mistaken for a failure
    // to read the key table below.
    const handshakeAuth = client.handshake.auth as { apiKey?: unknown } | undefined;
    const authKey = typeof handshakeAuth?.apiKey === 'string' ? handshakeAuth.apiKey : undefined;
    const apiKey = authKey || (client.handshake.headers['x-api-key'] as string | undefined);
    const sessionCookie = !apiKey ? extractBrowserSessionCookie(client.handshake.headers.cookie) : undefined;

    if (!apiKey && !(sessionCookie && this.browserSessionService)) {
      this.logger.warn(`Client ${client.id} rejected: No API key provided`);
      if (allowUnauthenticatedAuditRow(clientIp)) {
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          ipAddress: clientIp,
          metadata: { surface: 'websocket' },
          errorMessage: 'missing API key',
        });
      }
      client.emit('message', this.createError('UNAUTHORIZED', 'API key required'));
      client.disconnect(true);
      return;
    }

    if (!apiKey && sessionCookie) {
      const origin = firstHeaderValue(client.handshake.headers.origin);
      const trustedProxies = readTrustedProxies();
      const cookieReq: CookieRequestLike = {
        secure: Boolean((client.handshake as { secure?: boolean }).secure),
        ip: client.handshake.address,
        socket: { remoteAddress: client.handshake.address },
        headers: client.handshake.headers ?? {},
      };
      if (!isAllowedBrowserWsHandshake(cookieReq, trustedProxies, process.env.CORS_ORIGINS, process.env.NODE_ENV)) {
        this.logger.warn(`Client ${client.id} rejected: Cross-origin cookie WebSocket handshake refused`);
        if (allowUnauthenticatedAuditRow(clientIp)) {
          void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
            ipAddress: clientIp,
            metadata: { surface: 'websocket', authMethod: 'cookie', origin: origin ?? null },
            errorMessage: 'WebSocket origin not allowed for cookie authentication',
          });
        }
        client.emit('message', this.createError('UNAUTHORIZED', 'Authentication failed'));
        client.disconnect(true);
        return;
      }
    }

    // The stored key validateApiKey resolved before refusing it, so the refusal's audit row names it as the REST
    // guard's does. Engine.IO serves /socket.io/ ahead of the Express middleware that opens a request context,
    // so the validation runs in one of its own and the key is read back from it.
    let refusedKey: Pick<ApiKey, 'id' | 'name'> | undefined;
    try {
      // validateApiKey THROWS on any failure (it never resolves to a falsy value), so the rejection
      // path is the catch below. The clientIp is passed so an IP-restricted key (allowedIps set) is
      // ENFORCED rather than blanket-rejected for "Client IP could not be determined".
      let validKey: ApiKey;
      let browserSessionId: string | undefined;
      let browserSessionExpiresAt: Date | string | null | undefined;
      if (apiKey) {
        validKey = await runWithRequestId(randomUUID(), () =>
          this.authService.validateApiKey(apiKey, clientIp).catch((error: unknown) => {
            const actor = getRequestActor();
            if (actor?.apiKeyId) refusedKey = { id: actor.apiKeyId, name: actor.apiKeyName ?? '' };
            throw error;
          }),
        );
      } else {
        const validated = await runWithRequestId(randomUUID(), () =>
          this.browserSessionService!.validateSessionToken(sessionCookie!, clientIp).catch((error: unknown) => {
            const actor = getRequestActor();
            if (actor?.apiKeyId) refusedKey = { id: actor.apiKeyId, name: actor.apiKeyName ?? '' };
            throw error;
          }),
        );
        validKey = validated.apiKey;
        browserSessionId = validated.session.id;
        browserSessionExpiresAt = validated.session.expiresAt ?? null;
      }

      // Cap simultaneous sockets per key: each socket holds rooms, engine fan-out, and memory,
      // so one key must not open connections without bound. Enough for multi-tab dashboards;
      // excess connections get a clear error, not a silent drop.
      const existing = this.socketsByKeyId.get(validKey.id);
      if (existing && existing.size >= this.rateLimits.maxSocketsPerKey) {
        this.logger.warn(
          `Client ${client.id} rejected: socket cap reached for key ${validKey.id} (${this.rateLimits.maxSocketsPerKey})`,
        );
        this.noteRateLimitViolation('sockets', { apiKeyId: validKey.id, ipAddress: clientIp });
        client.emit(
          'message',
          this.createError(
            'RATE_LIMITED',
            `Too many concurrent connections for this API key (max ${this.rateLimits.maxSocketsPerKey})`,
          ),
        );
        client.disconnect(true);
        return;
      }

      // Store the validated key plus either the raw API key (header/auth handshake) or the opaque
      // browserSessionId (cookie handshake) so handleSubscribe re-validates live authorization on
      // every subscription without ever caching a raw API key on cookie-authenticated sockets.
      (client.data as { apiKey: unknown; apiKeyId: string }).apiKey = validKey;
      (client.data as { apiKeyId: string }).apiKeyId = validKey.id;
      if (apiKey) {
        (client.data as { rawApiKey: string }).rawApiKey = apiKey;
      } else if (browserSessionId) {
        (client.data as { browserSessionId: string }).browserSessionId = browserSessionId;
        (client.data as { browserSessionExpiresAt?: Date | string | null }).browserSessionExpiresAt =
          browserSessionExpiresAt ?? null;
      }
      this.trackSocket(validKey.id, client, browserSessionId);
      // The handshake window is charged pre-auth to keep an unauthenticated flood off the DB. This
      // one turned out to be authentic, so give the slot back: the window then bounds FAILED
      // handshakes, and authenticated connections stay bounded by maxSocketsPerKey above. Without
      // this, every client behind one NAT/proxy IP shares a 10/min budget and normal dashboard
      // re-mounts lock each other out.
      this.handshakeLimiter.refund(handshakeKey, handshakeReservation);
      // The transport can close while validateApiKey is in flight, and Nest runs the disconnect
      // handler before this one returns. That untrack found no key on client.data yet and did
      // nothing, so the socket just tracked would stay in the per-key set for the life of the
      // process, holding a slot of the cap above and keeping the Socket object reachable.
      if (client.disconnected) {
        this.untrackSocket(client);
        // Logged rather than returned silently: the disconnect handler has already written a
        // "Client disconnected" line for a client nothing ever announced as connected.
        this.logger.log(`Client ${client.id} authenticated after it had already gone (key: ${validKey.name})`);
        return;
      }
      if (this.chatScope.isRestricted(validKey)) {
        void this.syncRestrictedPresence();
      }
      this.logger.log(`Client connected: ${client.id} (key: ${validKey.name})`);
    } catch (error) {
      if (!isKeyRefusal(error)) {
        // The key table could not be read: no verdict on the credential, so no authentication failure is
        // audited, and the client is told to retry rather than that its key failed.
        this.logger.error(
          `Client ${client.id} rejected: API key could not be checked`,
          error instanceof Error ? error.stack : String(error),
        );
        client.emit('message', this.createError('INTERNAL_ERROR', KEY_UNREADABLE_MESSAGE));
        client.disconnect(true);
        return;
      }
      this.logger.warn(`Client ${client.id} rejected: Auth error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Audit the rejected credential like the REST guard does, so probing over the WS surface leaves
      // a forensic trail too. Fire-and-forget: audit logging must never affect the rejection path.
      if (refusedKey || allowUnauthenticatedAuditRow(clientIp)) {
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          apiKey: refusedKey as ApiKey | undefined,
          ipAddress: clientIp,
          metadata: { surface: 'websocket' },
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      client.emit('message', this.createError('UNAUTHORIZED', 'Authentication failed'));
      client.disconnect(true);
    }
  }

  /**
   * Record a stored key refused after its authorization changed while the socket was connected.
   */
  private auditAuthorizationRefusal(apiKey: ApiKey, clientIp: string, message: string): void {
    void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
      apiKey,
      ipAddress: clientIp,
      metadata: { surface: 'websocket' },
      errorMessage: message,
    });
  }

  handleDisconnect(client: Socket) {
    this.untrackSocket(client);
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Answer a client command on the documented `message` event, and hand the same frame back so a
   * client that passed an ack callback still receives it.
   *
   * Returning alone is not enough. The Socket.IO adapter delivers a handler's return value through
   * the ack callback and nothing else, so a client that emits without one, which the dashboard and
   * the documented example client both do, never saw a subscribe confirmation, a pong, or any of the
   * refusals (FORBIDDEN_SESSION, INVALID_SESSION, INVALID_EVENTS, INVALID_MESSAGE).
   *
   * A path that answered and then closed the socket keeps its own emit, and this skips it rather than
   * emitting again: socket.io still accepts a write to a disconnected socket, so without the guard a
   * client could be handed the same frame twice on its way out.
   */
  private reply<T>(client: Socket, frame: T): T {
    if (!client.disconnected) {
      client.emit('message', frame);
    }
    return frame;
  }

  @SubscribeMessage('message')
  // A client may emit 'message' with no payload or with null, so the body is typed as possibly nil and
  // every read is guarded: such a frame answers INVALID_MESSAGE instead of throwing in the handler.
  async handleMessage(@ConnectedSocket() client: Socket, @MessageBody() incoming: WSClientMessage | null | undefined) {
    const message = withSafeRequestId(incoming);
    // Per-key token bucket on every inbound frame. Keyed by the validated key id; a socket
    // whose handshake validation is still in flight has no key yet and is metered by IP.
    // Over-budget frames get an error frame back and are NOT dispatched to a handler — in
    // particular they never reach the per-subscribe DB re-validation.
    const frameSubject =
      (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id ??
      limiterKeyForIp(this.resolveClientIp(client));
    if (!this.frameLimiter.allow(frameSubject)) {
      const requestId = (message as { requestId?: string } | null | undefined)?.requestId;
      this.noteRateLimitViolation('frame', {
        apiKeyId: (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id,
        ipAddress: this.resolveClientIp(client),
      });
      return this.reply(client, this.createError('RATE_LIMITED', 'Frame rate limit exceeded, slow down', requestId));
    }

    // A frame sent during the handshake waits for it. Without this a subscribe found no key on the socket
    // and was refused as 'API key is no longer valid', a server-side close the client does not retry.
    // A socket the handshake refused has already been answered and closed, so its frame is dropped.
    await (client.data as { authReady?: Promise<void> }).authReady;
    if (client.disconnected) {
      return undefined;
    }

    switch (message?.type) {
      case 'subscribe':
        return this.reply(client, await this.handleSubscribe(client, message));
      case 'unsubscribe':
        return this.reply(client, this.handleUnsubscribe(client, message));
      case 'ping':
        return this.reply(client, this.handlePing(client, message.requestId));
      default:
        return this.reply(
          client,
          this.createError(
            'INVALID_MESSAGE',
            `Unknown message type`,
            (message as { requestId?: string } | null | undefined)?.requestId,
          ),
        );
    }
  }

  private async handleSubscribe(
    client: Socket,
    message: WSSubscribeRequest,
  ): Promise<WSSubscribedResponse | WSErrorResponse> {
    const { sessionId, events, requestId } = message;

    // Validate sessionId
    if (!sessionId || typeof sessionId !== 'string') {
      return this.createError('INVALID_SESSION', 'sessionId is required', requestId);
    }
    if (!isSessionSelector(sessionId)) {
      return this.createError('INVALID_SESSION', 'sessionId must be "*" or a session id', requestId);
    }

    // Re-validate the API key on every subscribe: a long-lived socket whose key was
    // revoked/expired after connect must not be able to keep opening new subscriptions.
    // The clientIp is re-resolved (trusted-proxy-aware) so an IP-restricted key is enforced
    // here too, not just at connect.
    const rawApiKey = (client.data as { rawApiKey?: string }).rawApiKey;
    const browserSessionId = (client.data as { browserSessionId?: string }).browserSessionId;
    const clientIp = this.resolveClientIp(client);
    const subscription = { sessionId, cancelled: false };
    let pending = this.pendingSubscriptions.get(client);
    if (!pending) {
      pending = new Set();
      this.pendingSubscriptions.set(client, pending);
    }
    pending.add(subscription);
    let subscriberKey: ApiKey | null;
    let unreadable = false;
    try {
      if (rawApiKey) {
        subscriberKey = await this.authService.validateApiKey(rawApiKey, clientIp);
      } else if (browserSessionId && this.browserSessionService) {
        const validated = await this.browserSessionService.validateSessionById(browserSessionId, clientIp);
        subscriberKey = validated.apiKey;
      } else {
        subscriberKey = null;
      }
    } catch (error) {
      subscriberKey = null;
      if (isKeyRefusal(error)) {
        // A key refused here was valid at connect (revoked, expired, deleted or IP-refused since), so it
        // is audited like the handshake refusal, naming the key the socket connected with; the socket is
        // disconnected below, bounding the volume.
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          apiKey: (client.data as { apiKey?: ApiKey }).apiKey,
          ipAddress: clientIp,
          metadata: { surface: 'websocket' },
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } else {
        unreadable = true;
        this.logger.error(
          `Subscribe from ${client.id} failed: API key could not be checked`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    } finally {
      pending.delete(subscription);
      if (pending.size === 0) this.pendingSubscriptions.delete(client);
    }
    // Like a REST call that answers 500, this subscribe fails and joins nothing, and the socket keeps what it
    // already holds: the key was not judged, and the periodic sweep still re-validates it.
    if (unreadable) {
      return this.createError('INTERNAL_ERROR', KEY_UNREADABLE_MESSAGE, requestId);
    }
    if (!subscriberKey) {
      client.emit('message', this.createError('UNAUTHORIZED', 'API key is no longer valid', requestId));
      client.disconnect(true);
      return this.createError('UNAUTHORIZED', 'API key is no longer valid', requestId);
    }

    // The socket can have been evicted while this re-validation was in flight (a revoke landing on
    // the same tick as a subscribe). Joining rooms now would register a disconnected socket in the
    // adapter, where nothing prunes it again.
    if (client.disconnected) {
      return this.createError('UNAUTHORIZED', 'Connection is closed', requestId);
    }

    const snapshot = (client.data as { apiKey?: ApiKey }).apiKey;
    const chatRestricted = this.chatScope.isRestricted(subscriberKey);
    // A changed chat fence cannot reuse rooms granted under the previous authorization.
    if (
      (chatRestricted || this.chatScope.isRestricted(snapshot)) &&
      apiKeyAuthorizationFingerprint(subscriberKey) !== this.snapshotFingerprint(client)
    ) {
      const refusal = this.createError('UNAUTHORIZED', EVICTION_MESSAGES.authorization_changed, requestId);
      this.auditAuthorizationRefusal(subscriberKey, clientIp, refusal.message);
      client.emit('message', refusal);
      client.disconnect(true);
      return refusal;
    }

    // The fresh key decides THIS subscribe, and is deliberately not written back over the connect-time
    // snapshot in client.data: rooms joined earlier are never revisited, so a socket that refreshed its
    // snapshot here would look current to the sweep while still holding rooms its key has since lost.
    // What it does record is that the two diverged, since everything granted below outlives the key
    // state that granted it, and the row can be back to the snapshot by the time the sweep reads it.
    if (apiKeyAuthorizationFingerprint(subscriberKey) !== this.snapshotFingerprint(client)) {
      (client.data as { authorizationDiverged?: boolean }).authorizationDiverged = true;
    }
    this.syncQrAccess(client, subscriberKey.role);

    // Enforce per-key session scope against the FRESH key: a key restricted to specific
    // sessions must not subscribe to '*' or a session outside its allowlist (#221).
    if (!isSessionSubscriptionAllowed(subscriberKey.allowedSessions, sessionId)) {
      return this.createError('FORBIDDEN_SESSION', 'API key is not authorized for this session', requestId);
    }

    // Validate events
    if (!events || !Array.isArray(events) || events.length === 0) {
      return this.createError('INVALID_EVENTS', 'events array is required', requestId);
    }

    // Validate each event type
    const validEvents = [
      ...new Set(
        events.filter(e => e === '*' || SUBSCRIBABLE_EVENTS.includes(e as (typeof SUBSCRIBABLE_EVENTS)[number])),
      ),
    ];
    if (validEvents.length === 0) {
      return this.createError(
        'INVALID_EVENTS',
        `No valid events. Valid: ${SUBSCRIBABLE_EVENTS.join(', ')}, *`,
        requestId,
      );
    }

    const permittedEvents = chatRestricted
      ? validEvents.filter(event => event === '*' || CHAT_EVENTS.has(event))
      : validEvents;
    if (permittedEvents.length === 0) {
      return this.createError('FORBIDDEN_EVENTS', 'API key may subscribe only to chat events', requestId);
    }
    const chats = chatRestricted ? [...this.chatScope.scopeFor(subscriberKey)!.allowed] : undefined;
    // A socket holds every room it asks for, so events x chats rooms that exceed the cap can never fit.
    // Refused here, before the names are built: a large allowlist made each refused frame cost real time.
    // No amount of unsubscribing makes that fit, so the reply names the cost per event, not the generic text.
    if (chats && permittedEvents.length * chats.length > MAX_ROOMS_PER_SOCKET) {
      // Fewer events help only while one event fits: a list stored before allowedChats was bounded may not.
      const remedy = chats.length <= MAX_ROOMS_PER_SOCKET ? 'name fewer events or use "*"' : 'shorten the allowlist';
      return this.createError(
        'TOO_MANY_SUBSCRIPTIONS',
        `This key's chat allowlist makes every event ${chats.length} subscriptions and a connection may hold at most ${MAX_ROOMS_PER_SOCKET}; ${remedy}`,
        requestId,
      );
    }
    const rooms = permittedEvents.flatMap(event =>
      chats ? chats.map(chatId => chatRoom(sessionId, event, chatId)) : [buildRoomName(sessionId, event)],
    );
    if (rooms.length === 0) {
      return this.createError('FORBIDDEN_EVENTS', 'API key has no valid chats to subscribe to', requestId);
    }
    // Only subscription rooms count: the socket also sits in its own id room and may hold a role room.
    const held = [...client.rooms].filter(room => room.startsWith('session:')).length;
    const newRooms = rooms.filter(room => !client.rooms.has(room)).length;
    if (held + newRooms > MAX_ROOMS_PER_SOCKET) {
      return this.createError('TOO_MANY_SUBSCRIPTIONS', TOO_MANY_SUBSCRIPTIONS_MESSAGE, requestId);
    }

    if (subscription.cancelled) {
      return this.createError('SUBSCRIPTION_CANCELLED', 'Subscription was cancelled', requestId);
    }

    // Join rooms for each session/event combination
    for (const room of rooms) {
      void client.join(room);
    }
    if (chatRestricted) {
      await this.syncRestrictedPresence();
    }

    this.logger.debug(`Client ${client.id} subscribed to: ${rooms.join(', ')}`);

    return {
      type: 'subscribed',
      sessionId,
      events: permittedEvents,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  /** Put the socket in or out of the QR-denied room for its key's current role. */
  private syncQrAccess(client: Socket, role: ApiKeyRole | undefined): void {
    if (role && QR_ALLOWED_ROLES.has(role)) {
      void client.leave(QR_DENIED_ROOM);
    } else {
      void client.join(QR_DENIED_ROOM);
    }
  }

  private handleUnsubscribe(client: Socket, message: WSUnsubscribeRequest): WSUnsubscribedResponse | WSErrorResponse {
    const { sessionId, requestId } = message;
    // Same checks as subscribe: a missing sessionId matched no room, left every subscription in place,
    // and was still answered 'unsubscribed'. The reply carries the id back, so one no subscribe could
    // have accepted is refused rather than echoed.
    if (!sessionId || typeof sessionId !== 'string') {
      return this.createError('INVALID_SESSION', 'sessionId is required', requestId);
    }
    if (!isSessionSelector(sessionId)) {
      return this.createError('INVALID_SESSION', 'sessionId must be "*" or a session id', requestId);
    }

    for (const subscription of this.pendingSubscriptions.get(client) ?? []) {
      if (sessionId === '*' || subscription.sessionId === sessionId) subscription.cancelled = true;
    }

    // Leave all rooms for this session
    const clientRooms = Array.from(client.rooms);
    const sessionPrefix = `session:${sessionId}:`;

    for (const room of clientRooms) {
      if (room.startsWith(sessionPrefix) || (sessionId === '*' && room.startsWith('session:'))) {
        void client.leave(room);
      }
    }

    this.logger.debug(`Client ${client.id} unsubscribed from session: ${sessionId}`);

    return {
      type: 'unsubscribed',
      sessionId,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  private handlePing(_client: Socket, requestId?: string): WSPongResponse {
    return {
      type: 'pong',
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  private createError(code: string, message: string, requestId?: string): WSErrorResponse {
    return {
      type: 'error',
      code,
      message,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sampled audit for rate-limit violations: emits at most one row per kind+subject per minute
   * (fire-and-forget, like the auth-failure audit). Violations suppressed inside the window are
   * counted and folded into the next emitted row's `suppressed` metadata, so the forensic trail
   * stays accurate without one audit write per blocked frame/handshake.
   */
  private noteRateLimitViolation(
    kind: 'handshake' | 'frame' | 'sockets',
    subject: { apiKeyId?: string; ipAddress?: string },
  ): void {
    const mapKey = `${kind}:${subject.apiKeyId ?? (subject.ipAddress ? limiterKeyForIp(subject.ipAddress) : 'unknown')}`;
    const now = Date.now();
    const prior = this.violations.get(mapKey);
    if (prior && now - prior.since < EventsGateway.VIOLATION_AUDIT_WINDOW_MS) {
      prior.count += 1;
      return;
    }
    const suppressed = prior?.count ?? 0;
    this.violations.delete(mapKey);
    this.violations.set(mapKey, { count: 0, since: now });
    while (this.violations.size > EventsGateway.MAX_VIOLATION_KEYS) {
      const oldest = this.violations.keys().next().value;
      if (oldest === undefined) break;
      this.violations.delete(oldest);
    }
    void this.auditService.logWarn(AuditAction.RATE_LIMIT_EXCEEDED, {
      // Only the id is read (for the apiKeyId column) — enough to correlate with the key
      // without a DB lookup on a hot path.
      apiKey: subject.apiKeyId ? ({ id: subject.apiKeyId } as ApiKey) : undefined,
      ipAddress: subject.ipAddress,
      metadata: { surface: 'websocket', kind, suppressed },
      errorMessage: `websocket ${kind} rate limit exceeded`,
    });
  }

  // ========== Event Emission Methods (room-based) ==========

  /**
   * Emit event to specific rooms based on sessionId and event type
   */
  private emitToRooms(sessionId: string, event: string, data: unknown, exceptRoom?: string): void {
    if (this.destroyed) return;
    const eventMessage: WSEventMessage = {
      type: 'event',
      payload: { event, sessionId, data },
      timestamp: new Date().toISOString(),
    };

    // Emit once to the specific room + the three wildcard rooms. Chaining .to()
    // unions the rooms into a single broadcast, so a socket joined to several of
    // them receives the event exactly once (Socket.IO dedups recipients per
    // broadcast). Four separate .emit() calls would deliver one copy per room.
    // `except` is resolved by the adapter, so the exclusion also holds across nodes with Redis.
    // An event in WILDCARD_EXCLUDED_EVENTS skips the two event-'*' rooms: only sockets that named it
    // (for one session or for all) receive it.
    const named = this.server.to(buildRoomName(sessionId, event)).to(buildRoomName('*', event));
    const broadcast = WILDCARD_EXCLUDED_EVENTS.includes(event)
      ? named
      : named.to(buildRoomName(sessionId, '*')).to(buildRoomName('*', '*'));
    (exceptRoom ? broadcast.except(exceptRoom) : broadcast).emit('message', eventMessage);
    if (!CHAT_EVENTS.has(event) || data === null || typeof data !== 'object') return;
    if (this.destroyed) return;
    const value = data as Record<string, unknown>;
    const chatId = event.startsWith('group.') ? value.groupId : value.chatId;
    if (typeof chatId !== 'string' || !chatId.trim()) return;
    const localRestricted = this.hasLocalRestrictedSocket();
    if (!isWsRedisEnabled() && !localRestricted) {
      return;
    }
    // Expand the emitted identity using persisted mappings, so new LID mappings work
    // without rejoining rooms. Literal allowlist rooms also enforce the fence across Redis nodes.
    // Under REDIS_ENABLED=true without a local restricted socket, consult cluster presence first
    // so replicas skip lid_mappings lookups and chat-room fan-out when Redis confirms zero
    // restricted nodes exist cluster-wide (failing open when Redis is absent, disconnected, or errors).
    // Resolve identities concurrently while retaining FIFO event order within each session (with
    // per-chat queue bounds so stalled lookups/clients cannot grow heap unboundedly).
    const idsPromise =
      localRestricted || !this.restrictedPresence
        ? this.chatIds(sessionId, chatId)
        : this.restrictedPresence
            .hasRestrictedNodes()
            .then(hasAny => (hasAny ? this.chatIds(sessionId, chatId) : undefined));
    void idsPromise.catch(() => undefined);
    if (this.destroyed) return;
    let queue = this.chatDeliveries.get(sessionId);
    if (!queue) {
      queue = [];
      this.chatDeliveries.set(sessionId, queue);
    }
    let chatCount = 0;
    let oldestChatIdx = -1;
    for (let idx = 0; idx < queue.length; idx++) {
      if (queue[idx].chatId === chatId) {
        if (oldestChatIdx === -1) oldestChatIdx = idx;
        chatCount++;
      }
    }
    if (chatCount >= MAX_CHAT_DELIVERIES_PER_CHAT && oldestChatIdx !== -1) {
      queue.splice(oldestChatIdx, 1);
      this.noteDroppedChatDelivery(`${sessionId}:${chatId}`, 'chat', MAX_CHAT_DELIVERIES_PER_CHAT);
    } else if (queue.length >= MAX_CHAT_DELIVERIES_PER_SESSION) {
      const dropped = queue.shift();
      if (dropped) {
        this.noteDroppedChatDelivery(`${sessionId}:${dropped.chatId}`, 'session', MAX_CHAT_DELIVERIES_PER_SESSION);
      }
    }
    queue.push({ event, chatId, sessionId, eventMessage, idsPromise });
    if (!this.chatDeliveryActive.has(sessionId)) {
      this.chatDeliveryActive.add(sessionId);
      void this.drainChatDeliveries(sessionId);
    }
  }

  private noteDroppedChatDelivery(queueKey: string, scope: 'chat' | 'session', maxQueued: number): void {
    const now = Date.now();
    const warnKey = `${scope}:${queueKey}`;
    const state = this.chatDeliveryDropWarn.get(warnKey) ?? { at: -Infinity, dropped: 0 };
    state.dropped++;
    if (now - state.at >= CHAT_DELIVERY_DROP_WARN_INTERVAL_MS) {
      const dropped = state.dropped;
      state.at = now;
      state.dropped = 0;
      this.logger.warn(
        scope === 'chat'
          ? 'Dropped oldest queued WebSocket chat delivery at per-chat depth cap'
          : 'Dropped oldest queued WebSocket chat delivery at per-session depth cap',
        {
          scope,
          queueKey,
          dropped,
          maxQueued,
        },
      );
    }
    this.chatDeliveryDropWarn.delete(warnKey);
    this.chatDeliveryDropWarn.set(warnKey, state);
    while (this.chatDeliveryDropWarn.size > CHAT_DELIVERY_DROP_WARN_MAX) {
      const oldest = this.chatDeliveryDropWarn.keys().next().value;
      if (oldest === undefined) break;
      this.chatDeliveryDropWarn.delete(oldest);
    }
  }

  private async drainChatDeliveries(sessionId: string): Promise<void> {
    if (this.destroyed) return;
    try {
      while (!this.destroyed) {
        const queue = this.chatDeliveries.get(sessionId);
        const item = queue?.shift();
        if (!item) break;
        try {
          const ids = await item.idsPromise;
          if (this.destroyed || !ids?.length) continue;
          const rooms = ids.flatMap(id => {
            const namedRooms = [chatRoom(item.sessionId, item.event, id), chatRoom('*', item.event, id)];
            return WILDCARD_EXCLUDED_EVENTS.includes(item.event)
              ? namedRooms
              : [...namedRooms, chatRoom(item.sessionId, '*', id), chatRoom('*', '*', id)];
          });
          this.server.to(rooms).emit('message', item.eventMessage);
        } catch (error) {
          this.logger.warn('Could not resolve chat identity for WebSocket delivery', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.chatDeliveryActive.delete(sessionId);
      const remaining = this.chatDeliveries.get(sessionId);
      if (this.destroyed || (remaining && remaining.length === 0)) {
        this.chatDeliveries.delete(sessionId);
      } else if (remaining && remaining.length > 0 && !this.chatDeliveryActive.has(sessionId)) {
        this.chatDeliveryActive.add(sessionId);
        void this.drainChatDeliveries(sessionId);
      }
    }
  }

  /**
   * Evict cached chat-identity expansions for `chatId` (across all sessions and equivalent user/LID
   * address forms), or clear the entire memo when omitted. Called automatically when
   * LidMappingStoreService persists a new mapping so stale negative entries clear immediately.
   */
  invalidateChatIdsMemo(chatId?: string): void {
    if (!chatId) {
      this.chatIdsMemo.clear();
      return;
    }
    const target = parseWaId(chatId);
    const targetPhoneDigits =
      target.kind === 'user'
        ? target.userPart
        : target.kind === 'unknown' && /^\d+$/.test(target.userPart)
          ? target.userPart
          : null;
    for (const memoKey of this.chatIdsMemo.keys()) {
      const sep = memoKey.indexOf('\n');
      const entryChatId = sep === -1 ? memoKey : memoKey.slice(sep + 1);
      if (entryChatId === chatId) {
        this.chatIdsMemo.delete(memoKey);
        continue;
      }
      const entry = parseWaId(entryChatId);
      if (
        (target.kind === 'user' || target.kind === 'lid') &&
        entry.kind === target.kind &&
        entry.userPart === target.userPart
      ) {
        this.chatIdsMemo.delete(memoKey);
        continue;
      }
      if (
        targetPhoneDigits !== null &&
        ((entry.kind === 'user' && entry.userPart === targetPhoneDigits) ||
          (entry.kind === 'unknown' && /^\d+$/.test(entry.userPart) && entry.userPart === targetPhoneDigits))
      ) {
        this.chatIdsMemo.delete(memoKey);
      }
    }
  }

  /**
   * Every identity of a chat that the lid table gives it: its own address forms plus the other dialect of a mapped
   * phone or lid. Events about one chat of one session that are raised while a lookup is in flight share it, and
   * both mapped and unmapped answers are reused for CHAT_IDS_MEMO_TTL_MS (evicted early by invalidateChatIdsMemo
   * whenever this node persists a new mapping). A failed lookup is dropped as soon as it settles, so the next event
   * retries and every event that shared the failure still fails closed. The key is the session as well as the chat so
   * that a slow lookup never holds up another session.
   */
  private chatIds(sessionId: string, chatId: string): Promise<string[] | undefined> {
    const memoKey = `${sessionId}\n${chatId}`;
    const memoized = this.chatIdsMemo.get(memoKey);
    if (memoized && memoized.expiresAt > Date.now()) return memoized.ids;

    const ids = this.chatScope.idsForFilter({ allowedChats: [chatId] });
    const entry = { ids, expiresAt: Date.now() + CHAT_IDS_MEMO_TTL_MS };
    this.chatIdsMemo.delete(memoKey);
    this.chatIdsMemo.set(memoKey, entry);
    if (this.chatIdsMemo.size > CHAT_IDS_MEMO_MAX) {
      const oldest = this.chatIdsMemo.keys().next().value;
      if (oldest !== undefined) this.chatIdsMemo.delete(oldest);
    }
    const forget = () => {
      if (this.chatIdsMemo.get(memoKey) === entry) this.chatIdsMemo.delete(memoKey);
    };
    void ids.catch(forget);
    return ids;
  }

  /**
   * Emit session status change
   */
  emitSessionStatus(sessionId: string, status: string, data?: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'session.status', { status, ...data });
  }

  /**
   * Emit session authenticated (engine reached READY). Mirrors the webhook payload.
   */
  emitSessionAuthenticated(sessionId: string, data: { phone: string; pushName: string }) {
    this.emitToRooms(sessionId, 'session.authenticated', data);
  }

  /**
   * Emit session disconnected. Carries the `reason` that the session.status flip drops.
   */
  emitSessionDisconnected(sessionId: string, data: { reason: string }) {
    this.emitToRooms(sessionId, 'session.disconnected', data);
  }

  /**
   * Emit a restriction change (imposed or lifted), mirroring the `session.restriction` webhook
   * payload. Needed live because a restriction can arrive with no status transition at all (the
   * Baileys reachout timelock rides a connect probe) — without this push the dashboard badge only
   * appeared on a full page reload.
   */
  emitSessionRestriction(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'session.restriction', data);
  }

  /**
   * The end of a ringing call, one method per outcome.
   *
   * Three methods rather than one taking the name as a parameter: the drift guard discovers emitters
   * by reflection and invokes each with an empty payload, so a parameterised name would leave the
   * event catalog unverifiable — exactly the drift the guard exists to catch.
   */
  emitCallAccepted(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'call.accepted', data);
  }

  emitCallRejected(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'call.rejected', data);
  }

  emitCallMissed(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'call.missed', data);
  }

  /**
   * Emit a presence update. Socket-subscribable as well as webhook-delivered because presence is the
   * one event whose whole value is being live — a webhook round-trip to render a typing indicator
   * has usually expired by the time it arrives. Only actual changes reach here (see the wiring).
   */
  emitPresenceUpdate(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'presence.update', data);
  }

  /** Emit an RSVP to a WhatsApp event (Baileys only). Payload mirrors the `event.response` webhook. */
  emitEventResponse(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'event.response', data);
  }

  /** Emit a voter's new selection on a poll. Payload mirrors the `poll.vote` webhook. */
  emitPollVote(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'poll.vote', data);
  }

  /**
   * Emit QR code update for a session. Scanning the QR links a device to the account, so it only
   * reaches keys that may read it over REST (OPERATOR and above).
   */
  emitQRCode(sessionId: string, qrCode: string) {
    this.emitToRooms(sessionId, 'session.qr', { qrCode }, QR_DENIED_ROOM);
  }

  /**
   * Cap for inline base64 media on the message events, shared with the webhook delivery path so
   * both outbound sinks emit the same omitted-marker contract for an over-cap blob. Without this,
   * every subscribed socket (and, with the Redis adapter, every replica's pub/sub link) receives a
   * full copy of a payload that can carry media up to MEDIA_DOWNLOAD_MAX_BYTES (~67 MB base64 for
   * the 50 MiB cap); status.received already keeps its events media-free.
   */
  private messageMediaInlineMaxBytes(): number {
    return this.configService.get<number>('webhook.mediaInlineMaxBytes', DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES);
  }

  /**
   * Emit new message notification
   */
  emitMessage(sessionId: string, message: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.received', this.shedMessageMedia(message));
  }

  /**
   * Emit message sent notification
   */
  emitMessageSent(sessionId: string, message: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.sent', this.shedMessageMedia(message));
  }

  private shedMessageMedia(message: Record<string, unknown>): Record<string, unknown> {
    return shedInlineMedia(message, this.messageMediaInlineMaxBytes());
  }

  /**
   * Emit a live delivery-status update. The payload mirrors the `message.ack` webhook exactly
   * (`id`, `messageId`, neutral `status`, the deprecated legacy numeric `ack`, and `chatId` when
   * the engine's update named the chat) so a socket client and a webhook consumer see the same
   * shape.
   */
  emitMessageAck(
    sessionId: string,
    data: { id: string; messageId: string; status: DeliveryStatus; ack: number; chatId?: string },
  ) {
    this.emitToRooms(sessionId, 'message.ack', data);
  }

  /**
   * Emit one recipient's receipt for a group or status message the account sent. Mirrors the
   * `message.receipt` webhook. Not delivered to '*' subscriptions (see WILDCARD_EXCLUDED_EVENTS).
   */
  emitMessageReceipt(
    sessionId: string,
    data: {
      id: string;
      messageId: string;
      chatId: string;
      participant: string;
      status: MessageReceiptStatus;
      timestamp: number;
    },
  ) {
    this.emitToRooms(sessionId, 'message.receipt', data);
  }

  /**
   * Emit message revoked ("deleted for everyone") notification
   */
  emitMessageRevoked(sessionId: string, message: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.revoked', message);
  }

  /**
   * Emit message reaction notification
   */
  emitMessageReaction(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.reaction', data);
  }

  /**
   * Emit message edited notification
   */
  emitMessageEdited(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.edited', data);
  }

  /**
   * Emit a group membership join (a user was added or joined via invite). Payload mirrors the
   * `group.join` webhook: `{ groupId, participantIds, timestamp, actorId? }`.
   */
  emitGroupJoin(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'group.join', data);
  }

  /**
   * Emit a group membership leave (a user left or was removed). Payload mirrors the
   * `group.leave` webhook: `{ groupId, participantIds, timestamp, actorId? }`.
   */
  emitGroupLeave(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'group.leave', data);
  }

  /**
   * Emit a group metadata update (subject/description/announce/locked). Payload mirrors the
   * `group.update` webhook: `{ groupId, participantIds, changes, timestamp, actorId? }`.
   */
  emitGroupUpdate(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'group.update', data);
  }

  /**
   * Emit a pending join request (someone asked to join a group the account admins, join-approval
   * on). Payload mirrors the `group.join_request` webhook:
   * `{ groupId, participantIds, timestamp, actorId? }` — participantIds are the users asking to
   * join; actorId is who created the request when the engine reports one.
   */
  emitGroupJoinRequest(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'group.join_request', data);
  }

  /**
   * Emit an incoming-call notification (a call is ringing). Payload mirrors the `call.received`
   * webhook: `{ callId, from, isVideo, isGroup, timestamp }`.
   */
  emitCallReceived(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'call.received', data);
  }

  /**
   * Emit a freshly ingested contact status (story). Payload mirrors the `status.received`
   * webhook — no media bytes, just identity/type/flags — so the dashboard can refresh its
   * statuses view live instead of waiting for a focus refetch.
   */
  emitStatusReceived(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'status.received', data);
  }
}
