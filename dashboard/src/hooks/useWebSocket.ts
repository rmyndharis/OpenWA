import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_ORIGIN } from '../services/api';
import { resolveSocketUrl, warnIfInsecureHttpUrl } from '../utils/urlSecurity';

interface SessionStatusEvent {
  sessionId: string;
  status: string;
  timestamp: string;
}

interface QRCodeEvent {
  sessionId: string;
  qrCode: string;
  timestamp: string;
}

interface MessageEvent {
  sessionId: string;
  message: Record<string, unknown>;
  timestamp: string;
}

interface MessageAckEvent {
  sessionId: string;
  id: string;
  messageId: string;
  // Neutral delivery status emitted by the backend (engine-agnostic), not a raw wwebjs ack integer.
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  // Deprecated legacy numeric ack kept for backward compatibility; prefer `status`.
  ack?: number;
  timestamp?: string;
}

interface MessageReactionEvent {
  sessionId: string;
  messageId: string;
  chatId: string;
  reaction: string;
  senderId: string;
  /**
   * The post-apply snapshot of every reaction on the message. ABSENT when the gateway holds no
   * stored copy of the message to compute it from, which it says by omitting the key rather than
   * sending an empty object — absent means "unknown", `{}` means "there are none left". Keep it
   * optional: normalising the absence away here is what makes a consumer's own fallback dead code.
   */
  reactions?: Record<string, string>;
  timestamp: string;
}

interface MessageEditedEvent {
  sessionId: string;
  messageId: string;
  chatId: string;
  body: string;
  timestamp: number;
}

interface MessageRevokedEvent {
  sessionId: string;
  id: string;
  /**
   * Id of the ORIGINAL deleted message. Optional: whatsapp-web.js can only resolve it when the
   * original is still in its local store, and Baileys sets it identical to `id`.
   */
  revokedId?: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
}

/** A freshly ingested contact status (story) — the dashboard uses it purely as a refetch signal. */
interface StatusReceivedEvent {
  sessionId: string;
  timestamp: string;
}

/** A restriction imposed or lifted — the dashboard uses it purely as a refetch signal for the badge. */
interface SessionRestrictionEvent {
  sessionId: string;
  timestamp: string;
}

/** Ack frame answering a client `subscribe` request (`{type: 'subscribed'}`). */
interface SubscribedEvent {
  sessionId: string;
  events: string[];
}

/** Error frame answering a client request (`{type: 'error'}`), e.g. FORBIDDEN_SESSION. */
interface ServerErrorEvent {
  code: string;
  message: string;
}

interface WebSocketEvents {
  onSessionStatus?: (event: SessionStatusEvent) => void;
  onQRCode?: (event: QRCodeEvent) => void;
  onMessage?: (event: MessageEvent) => void;
  onMessageAck?: (event: MessageAckEvent) => void;
  onMessageReaction?: (event: MessageReactionEvent) => void;
  onMessageRevoked?: (event: MessageRevokedEvent) => void;
  onMessageEdited?: (event: MessageEditedEvent) => void;
  onStatusReceived?: (event: StatusReceivedEvent) => void;
  onSessionRestriction?: (event: SessionRestrictionEvent) => void;
  onSubscribed?: (event: SubscribedEvent) => void;
  onServerError?: (event: ServerErrorEvent) => void;
}

// Shape of the server -> client event envelope produced by the NestJS gateway.
// `type` is the 'event' literal so the frame union below narrows on it.
interface ServerEventEnvelope {
  type: 'event';
  timestamp: string;
  payload?: {
    event: string;
    sessionId: string;
    data: Record<string, unknown>;
  };
}

// The gateway also answers client requests (subscribe/unsubscribe/ping) with ack frames
// (`subscribed` / `unsubscribed` / `pong`) and error frames (`error`) on the same 'message'
// channel. Routing them to the UI matters: a scoped key's rejected wildcard subscribe must be
// visible so the caller can fall back to per-session rooms instead of waiting forever.
interface ServerAckFrame {
  type: 'subscribed' | 'unsubscribed' | 'pong';
  sessionId?: string;
  events?: string[];
}

interface ServerErrorFrame {
  type: 'error';
  code?: string;
  message?: string;
}

// The origin of VITE_WS_URL when set, else of VITE_API_URL (a split-origin build names the API there), else the
// page's own origin (the single-container setup, or nginx proxying /socket.io in Docker).
const SOCKET_URL = resolveSocketUrl(import.meta.env.VITE_WS_URL, API_ORIGIN, window.location.origin);
// Warn when VITE_WS_URL is an insecure http:// or ws:// URL on a non-localhost host; api.ts already warns
// about VITE_API_URL under its own name.
if (import.meta.env.VITE_WS_URL) warnIfInsecureHttpUrl(SOCKET_URL, 'VITE_WS_URL');

// Pauses before a subscribe that joined nothing is sent again, about 48 s in all before the feed counts as failed.
const SUBSCRIBE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// The gateway meters every frame of a key, across all of its sockets, at 120 at once and then 60 a second. A scoped key
// with a hundred sessions has as many subscribes to send again, so they go out this many a second.
const SUBSCRIBE_RETRY_BATCH = 30;

interface Subscription {
  sessionId: string;
  events: string[];
}

// A page can hold more than one subscription of a session (Chats joins its session feed and, for the open one, its
// message feed), so a waiting retry is known by both.
const subscriptionKey = ({ sessionId, events }: Subscription) => `${sessionId}\n${events.join(',')}`;

export function useWebSocket(events: WebSocketEvents = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // True when the connection is dead until the user retries: Socket.IO either exhausted its
  // reconnection attempts, or the server itself closed the socket (rate limit, auth rejection,
  // key eviction — a server-initiated close sets skipReconnect, so no auto-reconnect runs and
  // `reconnect_failed` never fires). Lets the UI show a "connection lost" indicator + a manual
  // retry instead of silently going stale.
  const [connectionFailed, setConnectionFailed] = useState(false);
  // Bumped every time connect() creates a NEW socket instance. The envelope-handler effect below
  // captures socketRef.current when it runs; without this epoch in its deps, a manual reconnect()
  // (which swaps in a fresh socket) leaves the new socket with NO 'message' listener while
  // isConnected still reports true - realtime events stop arriving with no signal anywhere.
  const [socketEpoch, setSocketEpoch] = useState(0);

  // A subscribe the gateway could not judge, because its key store failed, is answered INTERNAL_ERROR, and one over the
  // key's frame budget RATE_LIMITED: it joins nothing and the socket stays open, so nothing else would send it again.
  // Such subscribes are sent again after each pause in SUBSCRIBE_RETRY_DELAYS_MS, SUBSCRIBE_RETRY_BATCH a second, and
  // a joined subscribe starts the pauses over. Once they have run out the connection counts as failed, so the page
  // shows its banner and retry. Every other refusal is final. Answers are matched to subscribes by the requestId the
  // gateway echoes, and a waiting retry is kept per session and events.
  // `retried`: the send ends a gap, so its join is reported. `joinedLater`: another send of it, sent before or after
  // this one, joined while this one was out.
  const pendingSubscribes = useRef(new Map<string, Subscription & { retried: boolean; joinedLater?: boolean }>());
  // The subscribes waiting for the next round, and those of the round being sent.
  const retryQueue = useRef(new Map<string, Subscription>());
  const retryDue = useRef(new Map<string, Subscription>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryRound = useRef(0);
  const lastRequestId = useRef(0);
  // Bumped when a subscribe that ends a retry's gap is joined, sent by the retry or again by the page, once for the
  // subscribes sent since the last bump: what its room pushed meanwhile is gone, so the page reads again what it holds,
  // as after a reconnect.
  const [rejoins, setRejoins] = useState(0);
  const rejoinNoted = useRef(false);
  // Retries dropped by leaving their session before they joined, until the page subscribes them again.
  const retryGaps = useRef(new Set<string>());

  const clearSubscribeRetry = useCallback(() => {
    clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
    pendingSubscribes.current.clear();
    retryQueue.current.clear();
    retryDue.current.clear();
    retryGaps.current.clear();
    retryRound.current = 0;
  }, []);

  const sendSubscribe = useCallback((sessionId: string, eventsList: string[], retried: boolean) => {
    if (!socketRef.current?.connected) return;
    const requestId = `sub-${++lastRequestId.current}`;
    const key = subscriptionKey({ sessionId, events: eventsList });
    // A page subscribe in place of a waiting, dropped or in-flight retry ends the same gap.
    const replacesRetry = [retryQueue.current, retryDue.current, retryGaps.current]
      .map(m => m.delete(key))
      .includes(true);
    const inFlight = [...pendingSubscribes.current.values()].some(p => p.retried && subscriptionKey(p) === key);
    const endsGap = retried || replacesRetry || inFlight;
    if (endsGap) rejoinNoted.current = false;
    pendingSubscribes.current.set(requestId, { sessionId, events: eventsList, retried: endsGap });
    socketRef.current.emit('message', {
      type: 'subscribe',
      sessionId,
      events: eventsList,
      requestId,
    });
  }, []);

  const subscribe = useCallback(
    (sessionId: string, eventsList: string[]) => sendSubscribe(sessionId, eventsList, false),
    [sendSubscribe],
  );

  const unsubscribe = useCallback((sessionId: string) => {
    for (const retries of [retryQueue.current, retryDue.current]) {
      for (const [key, queued] of retries) {
        if (queued.sessionId !== sessionId) continue;
        retries.delete(key);
        retryGaps.current.add(key);
      }
    }
    for (const [requestId, pending] of pendingSubscribes.current) {
      if (pending.sessionId !== sessionId) continue;
      pendingSubscribes.current.delete(requestId);
      // The gateway cancels a subscribe an unsubscribe overtakes, so a retry in flight never joined either.
      if (pending.retried) retryGaps.current.add(subscriptionKey(pending));
    }
    if (socketRef.current?.connected) {
      socketRef.current.emit('message', {
        type: 'unsubscribe',
        sessionId,
      });
    }
  }, []);

  // Starts the pause before the next round, unless a round is being sent or waited for. A subscribe that fails again
  // while its round is going out waits for the next one.
  const scheduleRetry = useCallback(() => {
    const sendDue = () => {
      retryTimer.current = undefined;
      for (const [key, { sessionId, events }] of [...retryDue.current].slice(0, SUBSCRIBE_RETRY_BATCH)) {
        retryDue.current.delete(key);
        sendSubscribe(sessionId, events, true);
      }
      if (retryDue.current.size > 0) retryTimer.current = setTimeout(sendDue, 1_000);
      else startPause();
    };
    const startPause = () => {
      if (retryTimer.current !== undefined || retryQueue.current.size === 0) return;
      const delay = SUBSCRIBE_RETRY_DELAYS_MS[retryRound.current];
      if (delay === undefined) {
        console.warn('[WebSocket] The gateway could not take a subscribe after every retry');
        retryQueue.current.clear();
        setConnectionFailed(true);
        return;
      }
      retryTimer.current = setTimeout(() => {
        retryRound.current += 1;
        retryDue.current = retryQueue.current;
        retryQueue.current = new Map();
        sendDue();
      }, delay);
    };
    startPause();
  }, [sendSubscribe]);

  const noteSubscribeAnswer = useCallback(
    (frame: { type?: string; code?: string; requestId?: string } | null | undefined) => {
      const requestId = frame?.requestId;
      const pending = requestId === undefined ? undefined : pendingSubscribes.current.get(requestId);
      if (!frame || requestId === undefined || !pending) return;
      pendingSubscribes.current.delete(requestId);
      const noteRejoin = () => {
        rejoinNoted.current = true;
        setRejoins(count => count + 1);
      };
      // The other sends of this subscription still being checked.
      const key = subscriptionKey(pending);
      const others = [...pendingSubscribes.current].filter(([, other]) => subscriptionKey(other) === key);
      if (frame.type === 'subscribed') {
        retryRound.current = 0;
        // Once this join is reported they decide nothing more; otherwise a failure of one is a gap this join ended.
        for (const [id, other] of others) {
          if (pending.retried) pendingSubscribes.current.delete(id);
          else other.joinedLater = true;
        }
        if (pending.retried && !rejoinNoted.current) noteRejoin();
      }
      if (frame.type !== 'error' || (frame.code !== 'INTERNAL_ERROR' && frame.code !== 'RATE_LIMITED')) return;
      if (pending.joinedLater) {
        // The room is joined: this report covers the other sends still out, as a reported join does.
        for (const [id] of others) pendingSubscribes.current.delete(id);
        return noteRejoin();
      }
      // Another send of it is still out: its join ends this gap, and its failure is retried.
      if (others.length > 0) {
        for (const [, other] of others) other.retried = true;
        rejoinNoted.current = false;
        return;
      }
      retryQueue.current.set(key, pending);
      scheduleRetry();
    },
    [scheduleRetry],
  );

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;

    // Get API key from sessionStorage (same as api.ts)
    const apiKey = sessionStorage.getItem('openwa_api_key');

    if (!apiKey) {
      console.warn('[WebSocket] No API key found, skipping connection');
      return;
    }

    setSocketEpoch(epoch => epoch + 1);
    clearSubscribeRetry();
    socketRef.current = io(`${SOCKET_URL}/events`, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      // Send the key via `auth` (and a header for proxies). NOT via `query` — a key in the
      // handshake URL leaks into access logs / Referer. The gateway reads auth first.
      auth: {
        apiKey,
      },
      extraHeaders: {
        'X-API-Key': apiKey,
      },
    });

    socketRef.current.on('connect', () => {
      setIsConnected(true);
      setConnectionFailed(false);
    });

    socketRef.current.on('message', noteSubscribeAnswer);

    socketRef.current.on('disconnect', reason => {
      setIsConnected(false);
      // The rooms went with the socket, and the page subscribes again once it is back.
      clearSubscribeRetry();
      // A server-initiated close (handshake rate limit, auth rejection, key eviction) sets
      // Socket.IO's skipReconnect: no auto-reconnect runs, so `reconnect_failed` never fires
      // and without this the tab would silently stop receiving events. Surface the same
      // recoverable failure state — the banner's manual retry opens a fresh socket, which
      // skipReconnect does not block.
      if (reason === 'io server disconnect') {
        setConnectionFailed(true);
      }
    });

    socketRef.current.on('connect_error', error => {
      console.warn('[WebSocket] Connection error:', error.message);
    });

    // `reconnect_failed` is emitted on the Manager once all reconnectionAttempts are exhausted.
    socketRef.current.io.on('reconnect_failed', () => {
      console.warn('[WebSocket] Reconnection failed after max attempts');
      setConnectionFailed(true);
    });
  }, [clearSubscribeRetry, noteSubscribeAnswer]);

  // Manual retry after the socket permanently gave up: tear down the dead socket and reconnect.
  const reconnect = useCallback(() => {
    setConnectionFailed(false);
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    connect();
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      clearSubscribeRetry();
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [connect, clearSubscribeRetry]);

  // Register the single envelope handler and fan out to the typed callbacks.
  useEffect(() => {
    if (!socketRef.current) return;

    const socket = socketRef.current;

    const handleIncomingMessage = (msg: ServerEventEnvelope | ServerAckFrame | ServerErrorFrame) => {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'error') {
        events.onServerError?.({ code: String(msg.code ?? ''), message: String(msg.message ?? '') });
        return;
      }
      if (msg.type === 'subscribed') {
        events.onSubscribed?.({
          sessionId: String(msg.sessionId ?? ''),
          events: Array.isArray(msg.events) ? msg.events : [],
        });
        return;
      }
      if (msg.type !== 'event' || !msg.payload) return;

      const { event, sessionId, data } = msg.payload;

      switch (event) {
        case 'session.status':
          events.onSessionStatus?.({ sessionId, status: String(data.status), timestamp: msg.timestamp });
          break;
        case 'session.qr':
          events.onQRCode?.({ sessionId, qrCode: String(data.qrCode), timestamp: msg.timestamp });
          break;
        case 'message.received':
        case 'message.sent':
          events.onMessage?.({ sessionId, message: data, timestamp: msg.timestamp });
          break;
        case 'status.received':
          events.onStatusReceived?.({ sessionId, timestamp: msg.timestamp });
          break;
        case 'session.restriction':
          events.onSessionRestriction?.({ sessionId, timestamp: msg.timestamp });
          break;
        case 'message.ack':
          events.onMessageAck?.({
            sessionId,
            id: String(data.id),
            messageId: String(data.messageId),
            status: data.status as MessageAckEvent['status'],
            ack: typeof data.ack === 'number' ? data.ack : undefined,
            timestamp: msg.timestamp,
          });
          break;
        case 'message.reaction':
          events.onMessageReaction?.({
            sessionId,
            messageId: String(data.messageId),
            chatId: String(data.chatId),
            reaction: String(data.reaction),
            senderId: String(data.senderId),
            // Carried through as-is, including absent: `|| {}` here would tell every consumer that
            // the message has no reactions left, which is a different claim from "we do not know".
            reactions: data.reactions as Record<string, string> | undefined,
            timestamp: msg.timestamp,
          });
          break;
        case 'message.revoked':
          events.onMessageRevoked?.({
            sessionId,
            id: String(data.id),
            // Not String()-coerced like its neighbours: the field is optional on the wire, and
            // String(undefined) would yield the truthy literal "undefined" and defeat the fallback.
            revokedId: typeof data.revokedId === 'string' ? data.revokedId : undefined,
            chatId: String(data.chatId),
            from: String(data.from),
            to: String(data.to),
            body: String(data.body ?? ''),
            type: String(data.type),
            timestamp: Number(data.timestamp),
          });
          break;
        case 'message.edited':
          // Keep optional/malformed wire fields from becoming the truthy strings "undefined"/"null"
          // and accidentally matching an unrelated cached row.
          if (
            typeof data.messageId !== 'string' ||
            !data.messageId ||
            typeof data.chatId !== 'string' ||
            typeof data.body !== 'string'
          ) {
            break;
          }
          events.onMessageEdited?.({
            sessionId,
            messageId: data.messageId,
            chatId: data.chatId,
            body: data.body,
            timestamp: Number(data.timestamp),
          });
          break;
        default:
          break;
      }
    };

    socket.on('message', handleIncomingMessage);

    return () => {
      socket.off('message', handleIncomingMessage);
    };
    // socketEpoch re-runs this effect for the socket a manual reconnect() swapped in; the cleanup
    // above detaches the handler from the dead instance first.
  }, [events, socketEpoch]);

  return { isConnected, connectionFailed, reconnect, subscribe, unsubscribe, rejoins };
}
