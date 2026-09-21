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
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { resolveCorsPolicy } from '../../config/bootstrap-security';
import { resolveClientIp as resolveRequestClientIp, type RequestLike } from '../../common/utils/ip';
import { DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES, shedInlineMedia } from '../../common/utils/inline-media';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import { apiKeyAuthorizationFingerprint, apiKeyExpiryTime } from '../auth/api-key-authorization';
import {
  readWsRateLimitConfig,
  TokenBucketLimiter,
  SlidingWindowLimiter,
  type WsRateLimitConfig,
} from './ws-rate-limit';

/**
 * WebSocket CORS origin: reuse the HTTP CORS policy instead of a hardcoded '*'.
 * Dev → allow any origin; production → the configured CORS_ORIGINS allowlist (or none).
 * Read from process.env at module load (real env vars apply; same-origin is unaffected).
 */
function resolveWsCorsOrigin(): boolean | string[] {
  const policy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  return policy.allowAnyOrigin ? true : policy.origins;
}

/**
 * Read TRUSTED_PROXIES once as a list — mirrors mcp.server.ts so the WS surface resolves the
 * client IP with the same trusted-proxy-aware logic as the REST guard and the MCP mount.
 */
function readTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
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
import type { DeliveryStatus } from '../../engine/interfaces/whatsapp-engine.interface';

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

/** Why an API key's live WebSocket sockets are being torn down — drives the client-facing message. */
export type ApiKeyEvictionReason = 'revoked' | 'deleted' | 'authorization_changed' | 'expired';

const EVICTION_MESSAGES: Record<ApiKeyEvictionReason, string> = {
  revoked: 'API key has been revoked',
  deleted: 'API key has been deleted',
  authorization_changed: 'API key authorization changed; please reconnect',
  expired: 'API key has expired',
};

@WebSocketGateway({
  cors: {
    origin: resolveWsCorsOrigin(),
  },
  namespace: '/events',
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private logger = new Logger('EventsGateway');

  /**
   * Active sockets keyed by their validating API-key id, so a key revoked/disabled
   * mid-connection can have its live subscriptions torn down immediately (otherwise
   * an already-subscribed socket keeps receiving events until it happens to disconnect).
   */
  private readonly socketsByKeyId = new Map<string, Set<Socket>>();
  private authzSweepTimer?: ReturnType<typeof setInterval>;

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
  ) {
    this.rateLimits = readWsRateLimitConfig();
    this.frameLimiter = new TokenBucketLimiter(this.rateLimits.framePerSecond, this.rateLimits.frameBurst);
    this.handshakeLimiter = new SlidingWindowLimiter(this.rateLimits.handshakeMax, this.rateLimits.handshakeWindowMs);
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
  }

  onModuleDestroy(): void {
    if (this.authzSweepTimer) clearInterval(this.authzSweepTimer);
    this.authzSweepTimer = undefined;
  }

  /**
   * Re-validate the keys behind the live sockets against the database, once per tick.
   *
   * A socket carries the key snapshot taken at connect and never refreshes it, so every later change
   * to the row is invisible to it: a key deleted, revoked, expired or narrowed by another node, by a
   * direct database write, or by an operator change that committed in the window between this
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
    if (keyIds.length === 0) return;
    const current = await this.authService.findAuthorizationStates(keyIds);
    const byId = new Map(current.map(key => [key.id, key]));
    for (const keyId of keyIds) {
      const reason = this.evictionReason(byId.get(keyId), this.socketsByKeyId.get(keyId), now);
      if (reason) this.evictApiKey(keyId, reason);
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

  private trackSocket(keyId: string, client: Socket): void {
    let sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByKeyId.set(keyId, sockets);
    }
    sockets.add(client);
  }

  private untrackSocket(client: Socket): void {
    const keyId = (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id;
    if (!keyId) return;
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) return;
    sockets.delete(client);
    if (sockets.size === 0) {
      this.socketsByKeyId.delete(keyId);
    }
  }

  /**
   * Tear down every active socket authenticated with `keyId`. Called by AuthService when a key is
   * revoked, deleted, or has its authorization (role/allowedSessions/allowedIps/expiry) narrowed, and
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
      client.emit('message', this.createError('UNAUTHORIZED', message));
      client.disconnect(true);
    }
  }

  async handleConnection(client: Socket) {
    // Resolve the client IP once here so the handshake throttle, the validation, and the
    // audit trail all use the same trusted-proxy-aware value (parity with the REST guard / MCP mount).
    const clientIp = this.resolveClientIp(client);

    // Pre-auth, per-IP handshake throttle. This must run BEFORE any credential handling: an
    // unauthenticated handshake flood otherwise reaches the DB validateApiKey below on every
    // attempt (same gap the MCP pre-auth IP throttle covers for the /mcp mount).
    if (!this.handshakeLimiter.allow(clientIp)) {
      this.logger.warn(`Client ${client.id} rejected: handshake rate limit exceeded (ip: ${clientIp})`);
      this.noteRateLimitViolation('handshake', { ipAddress: clientIp });
      client.emit('message', this.createError('RATE_LIMITED', 'Too many connection attempts, retry later'));
      client.disconnect();
      return;
    }

    // Accept the key only via Socket.IO's `auth` field or the header — never the query string, which
    // leaks the credential into proxy/access logs. (The deprecated `?apiKey=` fallback was removed.)
    const handshakeAuth = client.handshake.auth as { apiKey?: string } | undefined;
    const apiKey = handshakeAuth?.apiKey || (client.handshake.headers['x-api-key'] as string);

    if (!apiKey) {
      this.logger.warn(`Client ${client.id} rejected: No API key provided`);
      void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
        ipAddress: clientIp,
        metadata: { surface: 'websocket' },
        errorMessage: 'missing API key',
      });
      client.emit('message', this.createError('UNAUTHORIZED', 'API key required'));
      client.disconnect();
      return;
    }

    try {
      // validateApiKey THROWS on any failure (it never resolves to a falsy value), so the rejection
      // path is the catch below — a separate `if (!validKey)` branch here was dead code. The clientIp
      // is passed so an IP-restricted key (allowedIps set) is ENFORCED rather than blanket-rejected
      // for "Client IP could not be determined".
      const validKey = await this.authService.validateApiKey(apiKey, clientIp);

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
        client.disconnect();
        return;
      }

      // Store the validated key AND the raw key — the raw key lets handleSubscribe
      // RE-validate on each subscription so a key revoked mid-connection is caught.
      (client.data as { apiKey: unknown; rawApiKey: string }).apiKey = validKey;
      (client.data as { rawApiKey: string }).rawApiKey = apiKey;
      this.trackSocket(validKey.id, client);
      // The handshake window is charged pre-auth to keep an unauthenticated flood off the DB. This
      // one turned out to be authentic, so give the slot back: the window then bounds FAILED
      // handshakes, and authenticated connections stay bounded by maxSocketsPerKey above. Without
      // this, every client behind one NAT/proxy IP shares a 10/min budget and normal dashboard
      // re-mounts lock each other out.
      this.handshakeLimiter.refund(clientIp);
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
      this.logger.log(`Client connected: ${client.id} (key: ${validKey.name})`);
    } catch (error) {
      this.logger.warn(`Client ${client.id} rejected: Auth error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Audit the rejected credential like the REST guard does, so probing over the WS surface leaves
      // a forensic trail too. Fire-and-forget: audit logging must never affect the rejection path.
      void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
        ipAddress: clientIp,
        metadata: { surface: 'websocket' },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      client.emit('message', this.createError('UNAUTHORIZED', 'Authentication failed'));
      client.disconnect();
    }
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
  async handleMessage(@ConnectedSocket() client: Socket, @MessageBody() message: WSClientMessage) {
    // Per-key token bucket on every inbound frame. Keyed by the validated key id; a socket
    // whose handshake validation is still in flight has no key yet and is metered by IP.
    // Over-budget frames get an error frame back and are NOT dispatched to a handler — in
    // particular they never reach the per-subscribe DB re-validation.
    const frameSubject =
      (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id ?? this.resolveClientIp(client);
    if (!this.frameLimiter.allow(frameSubject)) {
      const requestId = (message as { requestId?: string } | undefined)?.requestId;
      this.noteRateLimitViolation('frame', {
        apiKeyId: (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id,
        ipAddress: this.resolveClientIp(client),
      });
      return this.reply(client, this.createError('RATE_LIMITED', 'Frame rate limit exceeded, slow down', requestId));
    }

    switch (message.type) {
      case 'subscribe':
        return this.reply(client, await this.handleSubscribe(client, message));
      case 'unsubscribe':
        return this.reply(client, this.handleUnsubscribe(client, message));
      case 'ping':
        return this.reply(client, this.handlePing(client, message.requestId));
      default:
        return this.reply(
          client,
          this.createError('INVALID_MESSAGE', `Unknown message type`, (message as { requestId?: string }).requestId),
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

    // Re-validate the API key on every subscribe: a long-lived socket whose key was
    // revoked/expired after connect must not be able to keep opening new subscriptions.
    // The clientIp is re-resolved (trusted-proxy-aware) so an IP-restricted key is enforced
    // here too, not just at connect.
    const rawApiKey = (client.data as { rawApiKey?: string }).rawApiKey;
    const clientIp = this.resolveClientIp(client);
    let subscriberKey: ApiKey | null;
    try {
      subscriberKey = rawApiKey ? await this.authService.validateApiKey(rawApiKey, clientIp) : null;
    } catch {
      subscriberKey = null;
    }
    if (!subscriberKey) {
      client.emit('message', this.createError('UNAUTHORIZED', 'API key is no longer valid', requestId));
      client.disconnect();
      return this.createError('UNAUTHORIZED', 'API key is no longer valid', requestId);
    }

    // The socket can have been evicted while this re-validation was in flight (a revoke landing on
    // the same tick as a subscribe). Joining rooms now would register a disconnected socket in the
    // adapter, where nothing prunes it again.
    if (client.disconnected) {
      return this.createError('UNAUTHORIZED', 'Connection is closed', requestId);
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
    const validEvents = events.filter(
      e => e === '*' || SUBSCRIBABLE_EVENTS.includes(e as (typeof SUBSCRIBABLE_EVENTS)[number]),
    );
    if (validEvents.length === 0) {
      return this.createError(
        'INVALID_EVENTS',
        `No valid events. Valid: ${SUBSCRIBABLE_EVENTS.join(', ')}, *`,
        requestId,
      );
    }

    // Join rooms for each session/event combination
    const rooms: string[] = [];
    for (const event of validEvents) {
      const room = buildRoomName(sessionId, event);
      void client.join(room);
      rooms.push(room);
    }

    this.logger.debug(`Client ${client.id} subscribed to: ${rooms.join(', ')}`);

    return {
      type: 'subscribed',
      sessionId,
      events: validEvents,
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

  private handleUnsubscribe(client: Socket, message: WSUnsubscribeRequest): WSUnsubscribedResponse {
    const { sessionId, requestId } = message;

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
    const mapKey = `${kind}:${subject.apiKeyId ?? subject.ipAddress ?? 'unknown'}`;
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
    const broadcast = this.server
      .to(buildRoomName(sessionId, event))
      .to(buildRoomName(sessionId, '*'))
      .to(buildRoomName('*', event))
      .to(buildRoomName('*', '*'));
    (exceptRoom ? broadcast.except(exceptRoom) : broadcast).emit('message', eventMessage);
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
   * (`id`, `messageId`, neutral `status`, and the deprecated legacy numeric `ack`) so a socket
   * client and a webhook consumer see the same shape.
   */
  emitMessageAck(sessionId: string, data: { id: string; messageId: string; status: DeliveryStatus; ack: number }) {
    this.emitToRooms(sessionId, 'message.ack', data);
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
