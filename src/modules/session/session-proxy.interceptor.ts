import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { Observable, of } from 'rxjs';
import type { Request, Response } from 'express';
import { Session } from './entities/session.entity';
import { SessionOwnershipService } from './session-ownership.service';
import { SESSION_SCOPED_KEY } from '../auth/decorators/auth.decorators';
import { createLogger } from '../../common/services/logger.service';
import { normalizeIp } from '../../common/utils/ip';

/** The request headers a forwarded call carries over. Everything else is this hop's business. */
const FORWARDED_REQUEST_HEADERS = ['x-api-key', 'authorization', 'content-type', 'accept'] as const;

/** The response headers relayed back. Deliberately short: hop-by-hop headers must not leak through. */
const RELAYED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'x-content-type-options',
  // Throttle answers come from the OWNER's counters, so the client must be told what the owner
  // said: without these a forwarded 429 arrives with no indication of when to retry. The suffixed
  // names are the ones the throttler actually sets (there is no bare Retry-After).
  'retry-after',
  'retry-after-short',
  'retry-after-medium',
  'retry-after-long',
  'x-ratelimit-limit-short',
  'x-ratelimit-remaining-short',
  'x-ratelimit-reset-short',
  'x-ratelimit-limit-medium',
  'x-ratelimit-remaining-medium',
  'x-ratelimit-reset-medium',
  'x-ratelimit-limit-long',
  'x-ratelimit-remaining-long',
  'x-ratelimit-reset-long',
] as const;

/** Marks a request as already forwarded once. Whatever happens, it is never forwarded again. */
export const FORWARDED_HEADER = 'x-openwa-forwarded';

/**
 * The URL to forward to: ALWAYS the owner's origin, carrying only the request's path and query.
 *
 * The request target is caller-controlled. HTTP/1.1 allows the absolute form
 * (`GET http://elsewhere/api/sessions/x HTTP/1.1`), Express matches the route for it, and
 * `req.originalUrl` then holds that absolute URI — where `new URL(originalUrl, base)` DISCARDS the
 * base entirely. Resolving that way would let an authenticated caller aim this node's forwarder at
 * any origin they choose and receive the response, with the credentials of the call attached: a
 * server-side request forgery that also exfiltrates the API key. Rebuilding from the owner's base
 * makes the origin structurally un-influenceable rather than merely validated.
 *
 * The rebuild carries the path and query only, and it does so through the URL setters rather than
 * `new URL(path, base)`: a `pathname` that begins with `//` (or that a control character re-parses
 * into) is a network-path reference, so `new URL('//elsewhere/x', base)` would resolve its authority
 * from the path and re-open the exact origin hijack this function exists to close. Assigning
 * `target.pathname` / `target.search` on a clone of the owner's origin never reinterprets the value
 * as an authority, so the host stays the owner's for every input. Routing cannot currently deliver
 * such a target (Express does not match a session route whose path starts with `//`), but the origin
 * must be un-influenceable by construction, not by the router's normalization holding.
 */
export function forwardTarget(originalUrl: string, ownerNodeUrl: string): string {
  const base = new URL(ownerNodeUrl);
  const requested = new URL(originalUrl, base);
  const target = new URL(base.toString());
  target.pathname = requested.pathname;
  target.search = requested.search;
  return target.toString();
}

/**
 * Routes a session-scoped request to the node hosting the session's engine.
 *
 * The ownership lease records WHERE each session runs; this is the piece that acts on it: a request
 * landing on the wrong node — a load balancer round-robining across replicas knows nothing about
 * session placement — is forwarded to the owner's `nodeUrl` and the owner's response is relayed
 * back. Interceptor rather than middleware so it runs AFTER the API-key guard: a node only spends
 * outbound work on requests that authenticated here first (the owner authenticates them again —
 * both nodes share the auth database).
 *
 * Entirely inert unless the operator configured routing: without NODE_URL on this node the
 * interceptor never even looks up the session, so single-node deployments pay nothing.
 *
 * Deliberate decisions:
 * - A LAPSED owner does not forward: the session is adoptable, and the local node handling the
 *   request (a POST /start claims it here) is the takeover semantic, not an error.
 * - A live owner WITHOUT a nodeUrl cannot be reached; the request proceeds locally and the
 *   engine-level "held by another node" conflict answers it — precise, if unrouteable.
 * - One hop only: a forwarded request is never forwarded again (FORWARDED_HEADER). The marker is
 *   client-settable, so it is verified rather than trusted: a marked request that still lands on a
 *   live non-owner — forged, or ownership moved mid-flight — is refused with a retryable 409
 *   instead of executed against a node with no engine.
 */
@Injectable()
export class SessionProxyInterceptor implements NestInterceptor {
  private readonly logger = createLogger('SessionProxyInterceptor');

  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http' || !this.ownership) return next.handle();
    // Routing is opt-in per deployment: a node that never announced its own URL is not part of a
    // routed topology, and the per-request ownership lookup would be pure overhead.
    if (!this.ownership.nodeUrl) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();

    const sessionId = this.sessionIdOf(context, request);
    if (!sessionId) return next.handle();
    // A malformed id cannot name a routed session, and on Postgres a raw findOne against the uuid
    // column throws (a 500) before the route's ParseUUIDPipe could answer 400 — skip routing and
    // let the pipe reject it.
    if (!isUUID(sessionId)) return next.handle();

    const owner = await this.sessions.findOne({
      where: { id: sessionId },
      select: { id: true, nodeId: true, nodeUrl: true, leaseExpiresAt: true },
    });
    if (!owner?.nodeId || owner.nodeId === this.ownership.nodeId) return next.handle();
    const leaseLive = owner.leaseExpiresAt != null && owner.leaseExpiresAt > new Date();
    if (!leaseLive) return next.handle();

    // One hop only — but never "execute anywhere": the hop marker is client-settable, so a request
    // marked forwarded that still lands on a live non-owner (forged header, or ownership moved
    // mid-flight) is refused rather than run here — a stop() on this node would write DISCONNECTED
    // while the owner's engine stays up. A retry re-routes against fresh ownership data.
    if (request.headers[FORWARDED_HEADER]) {
      throw new ConflictException(`Session ${sessionId} is running on another node`);
    }

    if (!owner.nodeUrl) return next.handle();

    await this.forward(request, context.switchToHttp().getResponse<Response>(), owner.nodeId, owner.nodeUrl);
    // The response has been written and ended here. Emit undefined rather than completing empty:
    // Nest resolves an interceptor's observable with `lastValueFrom`, which REJECTS on an empty one
    // (EmptyError) — every successful forward then travelled the unknown-exception path and logged
    // an ERROR stack, for a request that had in fact succeeded. Emitting leaves the already-sent
    // response untouched (verified end-to-end in session-proxy.e2e-spec).
    return of(undefined);
  }

  private sessionIdOf(context: ExecutionContext, request: Request): string | undefined {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    if (params.sessionId) return params.sessionId;
    const sessionScoped = this.reflector.getAllAndOverride<boolean>(SESSION_SCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return sessionScoped ? params.id : undefined;
  }

  private async forward(
    request: Request,
    response: Response,
    ownerNodeId: string,
    ownerNodeUrl: string,
  ): Promise<void> {
    const timeoutMs = this.configService?.get<number>('session.proxyTimeoutMs', 60_000) ?? 60_000;

    const headers: Record<string, string> = { [FORWARDED_HEADER]: this.ownership?.nodeId ?? '1' };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    // The owner re-authenticates the forwarded call (allowedIps) and throttles per client IP, so
    // the chain must carry what this hop observed — without it every forwarded call shows up as
    // THIS node's address. Standard proxy behavior: relay the inbound chain, append the immediate
    // peer. The owner only honors the chain when this node is in its TRUSTED_PROXIES (docs/13).
    const inbound = request.headers['x-forwarded-for'];
    const inboundChain = Array.isArray(inbound) ? inbound.join(', ') : inbound;
    const observedPeer = normalizeIp(request.socket?.remoteAddress || request.ip || '');
    if (observedPeer) {
      headers['x-forwarded-for'] = inboundChain ? `${inboundChain}, ${observedPeer}` : observedPeer;
    }

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    try {
      // Inside the try: a NODE_URL that is not a usable absolute URL makes this throw, and that is
      // an unreachable-owner condition (the 503 below names the node and the setting) — not a 500
      // on a request that had nothing wrong with it. Boot validation rejects such a value too.
      const target = forwardTarget(request.originalUrl, ownerNodeUrl);
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        // The body has already been parsed by this hop's JSON body-parser; re-serialising it is
        // byte-equivalent for the JSON API surface (there are no multipart session routes).
        body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });

      response.status(upstream.status);
      for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.setHeader('x-openwa-served-by', ownerNodeId);
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 0) response.send(body);
      else response.end();
    } catch (error) {
      this.logger.warn(`Forwarding to session owner '${ownerNodeId}' failed`, {
        ownerNodeUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({
        statusCode: 503,
        message:
          `this session is hosted on node '${ownerNodeId}', which could not be reached from this node — ` +
          'check the owner node and its NODE_URL',
        error: 'Service Unavailable',
      });
    }
  }
}
