import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable, of } from 'rxjs';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { Session } from './entities/session.entity';
import { SessionOwnershipService } from './session-ownership.service';
import { SESSION_SCOPED_KEY } from '../auth/decorators/auth.decorators';
import { createLogger } from '../../common/services/logger.service';
import { isTransientDbError } from '../../common/utils/db-errors';
import { normalizeIp } from '../../common/utils/ip';

/**
 * The request headers a forwarded call carries over. Everything else is this hop's business.
 * content-type is not among them: forward() sends every body as JSON and labels it so itself.
 * idempotency-key travels so the OWNER claims it: the claim is part of the request's meaning, not
 * of this hop.
 */
const FORWARDED_REQUEST_HEADERS = ['x-api-key', 'authorization', 'accept', 'idempotency-key'] as const;

/** The response headers relayed back. Deliberately short: hop-by-hop headers must not leak through. */
const RELAYED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'x-content-type-options',
  // Tells the client the owner answered from a stored Idempotency-Key response, not a new send.
  'idempotent-replayed',
  // Throttle answers come from the OWNER's counters, so the client must be told what the owner
  // said: without these a forwarded 429 arrives with no indication of when to retry.
  // ProxyAwareThrottlerGuard sets the plain Retry-After that HTTP clients read; the base throttler
  // adds the per-tier Retry-After-<name> and X-RateLimit-* headers. All of them are relayed.
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

/**
 * Connection-stage failure codes: the owner never received the request, so nothing ran there and a
 * retry cannot repeat an action. Any other failure may come after the owner started acting on it.
 */
const NOT_DISPATCHED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Marks a request as already forwarded once. Whatever happens, it is never forwarded again. */
export const FORWARDED_HEADER = 'x-openwa-forwarded';

/**
 * How much of the owner's answer is held whole before it is relayed. An ordinary JSON answer fits, and keeps the
 * all-or-nothing relay: a read that fails midway leaves no status or headers behind. A larger one, a media
 * download above all, is relayed as it arrives, because holding it would put a whole copy in memory for every
 * concurrent download through this node, which the owner itself does not do (it streams stored media).
 */
export const FORWARD_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * What was read ahead, then the rest of the owner's body. The read-ahead is let go as it is sent, so a slow client
 * does not keep it in memory for the whole transfer. The owner's request is cancelled if the relay stops early.
 */
async function* relayBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  held: Uint8Array[],
): AsyncGenerator<Uint8Array> {
  try {
    for (let chunk = held.shift(); chunk; chunk = held.shift()) yield chunk;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) yield chunk.value;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The longest delay a Node timer takes; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The URL to forward to: ALWAYS the owner's origin (under its NODE_URL path, if it has one),
 * carrying only the request's path and query.
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
  // Joined, not replaced: an owner behind a path-prefixed reverse proxy is reachable only under it.
  target.pathname = base.pathname.replace(/\/$/, '') + requested.pathname;
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
 * outbound work on requests that authenticated here first (the owner authenticates them again
 * against its own key store; API keys live in each node's main SQLite file and are not shared).
 *
 * Entirely inert unless the operator configured routing: without NODE_URL on this node the
 * interceptor never even looks up the session, so single-node deployments pay nothing.
 *
 * Deliberate decisions:
 * - A LAPSED owner does not forward: the session is adoptable, and the local node handling the
 *   request (a POST /start claims it here) is the takeover semantic, not an error.
 * - A live owner WITHOUT a nodeUrl cannot be reached; the request proceeds locally. Start, stop and
 *   delete answer 409 "running on another node"; logout, force-kill and every engine route answer
 *   their own 400 for a session not started here (docs/13 lists the answers).
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
    // An import keeps any safe key as a session id, so a non-UUID id can name a routed session. `sessions.id`
    // is varchar on both dialects, so such an id is looked up like any other; only a NUL byte would make
    // PostgreSQL fail the query, and no id carries one.
    if (!sessionId || sessionId.includes('\0')) return next.handle();

    let owner: Pick<Session, 'id' | 'nodeId' | 'nodeUrl' | 'leaseExpiresAt'> | null;
    try {
      owner = await this.sessions.findOne({
        where: { id: sessionId },
        select: { id: true, nodeId: true, nodeUrl: true, leaseExpiresAt: true },
      });
    } catch (error) {
      // This lookup is the first statement of every session request on a routed node. A database that cannot serve it
      // for the moment (isTransientDbError: a lost, refused or timed-out connection, a failed host lookup, a lock, a
      // connection limit, a database starting up or shutting down) has done nothing yet, so it answers the retryable
      // 503 that a start, stop or delete answers for its own checks, which a 500 from here would hide. Any other
      // failure is a fault and stays one.
      if (!isTransientDbError(error)) throw error;
      this.logger.warn('Could not look up the owner of a session; nothing was routed or run', {
        sessionId,
        action: 'session_owner_lookup_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableException(`Session ${sessionId} could not be routed; nothing was done, retry`);
    }
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

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const headers: Record<string, string> = { [FORWARDED_HEADER]: this.ownership?.nodeId ?? '1' };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    // Label the bytes actually sent: a form-encoded request, relabelled as the client sent it, would
    // have the owner's urlencoded parser read the JSON text as one form key and answer 400.
    if (hasBody) headers['content-type'] = 'application/json';

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

    // Aborted when the time runs out, named like AbortSignal.timeout's reason so a timeout is still told from a broken
    // connection below, and when the client leaves while a large answer is being relayed.
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new DOMException(`No answer within ${timeoutMs}ms`, 'TimeoutError')),
      Math.min(timeoutMs, MAX_TIMER_MS),
    );
    let target: string | undefined;
    try {
      // Inside the try: a NODE_URL that is not a usable absolute URL makes this throw, and that is
      // an unreachable-owner condition (the 503 below names the node and the setting), not a 500
      // on a request that had nothing wrong with it. Boot validation rejects such a value too.
      target = forwardTarget(request.originalUrl, ownerNodeUrl);
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        // The body has already been parsed by this hop's JSON or urlencoded body-parser; re-serialising
        // it as JSON keeps the parsed values the owner's DTOs would have seen (there are no multipart
        // session routes).
        body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
        signal: abort.signal,
        redirect: 'manual',
      });
      // Read up to the ceiling before touching the response, so a read that fails midway leaves no
      // relayed status or headers behind on the error answer below.
      const reader = upstream.body?.getReader();
      const held: Uint8Array[] = [];
      let heldBytes = 0;
      let ended = !reader;
      while (reader && !ended && heldBytes <= FORWARD_BUFFER_LIMIT_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) {
          ended = true;
        } else {
          held.push(chunk.value);
          heldBytes += chunk.value.byteLength;
        }
      }

      response.status(upstream.status);
      for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.setHeader('x-openwa-served-by', ownerNodeId);
      if (ended || !reader) {
        const body = Buffer.concat(held);
        if (body.length > 0) response.send(body);
        else response.end();
        return;
      }

      // Too large to hold: the rest is relayed as it arrives, with the reader paused while the client is slow. The time
      // limit covered getting this far; a slow client must not be cut by it, and an owner that stops sending is ended
      // by the dispatcher's own idle limit. The owner's length is kept so a short body cannot pass for the whole one,
      // unless fetch decoded the body, when it no longer describes the bytes.
      clearTimeout(timer);
      if (response.destroyed) {
        // The client left while the answer was being read: only the owner's request is left to let go.
        await reader.cancel().catch(() => undefined);
        return;
      }
      const length = upstream.headers.get('content-length');
      if (length && !upstream.headers.has('content-encoding')) response.setHeader('content-length', length);
      response.once('close', () => abort.abort());
      await pipeline(relayBody(reader, held), response);
    } catch (error) {
      // Duck-typed rather than `instanceof`: fetch rejects with a DOMException on timeout, and its
      // errors are not guaranteed to share this context's Error class.
      const failure = (error ?? {}) as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
      const code = failure.cause?.code;
      // The answer had begun (status and bytes are out): nothing honest is left to say, so the connection is cut and a
      // short body cannot pass for the whole one. A client that left is no failure of the owner. The response closing
      // aborts the fetch and the timer is cleared by now, so an aborted signal here can only mean that. It is judged by
      // that state, not by the error: pipeline reports a client that leaves while the next chunk is awaited as an
      // AggregateError, which no check of the error's shape would recognise.
      if (response.headersSent) {
        if (!abort.signal.aborted && failure.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          this.logger.warn(`Forwarding to session owner '${ownerNodeId}' broke after the answer began`, {
            ownerNodeUrl,
            error: error instanceof Error ? error.message : String(error),
            cause: code,
          });
        }
        response.destroy();
        return;
      }
      // fetch reports every network failure as 'fetch failed'; the cause code (a TLS certificate
      // error, a DNS failure) is what tells the operator what went wrong.
      this.logger.warn(`Forwarding to session owner '${ownerNodeId}' failed`, {
        ownerNodeUrl,
        error: error instanceof Error ? error.message : String(error),
        cause: code,
      });
      if (target === undefined || (typeof code === 'string' && NOT_DISPATCHED_CODES.has(code))) {
        // Nothing reached the owner: 503 is the honest, retryable answer.
        response.status(503).json({
          statusCode: 503,
          message:
            `this session is hosted on node '${ownerNodeId}', which could not be reached from this node — ` +
            'check the owner node and its NODE_URL',
          error: 'Service Unavailable',
        });
        return;
      }
      // Anything else may have happened after the request was sent (an unlisted error such as a TLS
      // handshake failure happens before it, but cannot be told apart), so the owner may have acted
      // on it. Never 503 here: clients treat 503 as declined-before-acting and replay non-idempotent
      // sends on it.
      const timedOut = failure.name === 'TimeoutError' || failure.name === 'AbortError';
      const status = timedOut ? 504 : 502;
      response.status(status).json({
        statusCode: status,
        message: timedOut
          ? `node '${ownerNodeId}', which hosts this session, did not answer within ${timeoutMs}ms; ` +
            'the request may still have been carried out there'
          : `forwarding to node '${ownerNodeId}', which hosts this session, failed, possibly after the request ` +
            'was sent; it may have been carried out there, check the owner node and its NODE_URL',
        error: timedOut ? 'Gateway Timeout' : 'Bad Gateway',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
