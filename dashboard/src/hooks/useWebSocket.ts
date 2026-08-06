import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';

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
  reactions: Record<string, string>;
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

// Use current origin for WebSocket (goes through nginx proxy in Docker)
// Falls back to env var or localhost for development
const SOCKET_URL = import.meta.env.VITE_WS_URL || window.location.origin;
// Warn when the WebSocket origin is an insecure http:// URL on a non-localhost host.
warnIfInsecureHttpUrl(SOCKET_URL, 'VITE_WS_URL');

export function useWebSocket(events: WebSocketEvents = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // True when the connection is dead until the user retries: Socket.IO either exhausted its
  // reconnection attempts, or the server itself closed the socket (rate limit, auth rejection,
  // key eviction — a server-initiated close sets skipReconnect, so no auto-reconnect runs and
  // `reconnect_failed` never fires). Lets the UI show a "connection lost" indicator + a manual
  // retry instead of silently going stale.
  const [connectionFailed, setConnectionFailed] = useState(false);

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;

    // Get API key from sessionStorage (same as api.ts)
    const apiKey = sessionStorage.getItem('openwa_api_key');

    if (!apiKey) {
      console.warn('[WebSocket] No API key found, skipping connection');
      return;
    }

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

    socketRef.current.on('disconnect', reason => {
      setIsConnected(false);
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
  }, []);

  // Manual retry after the socket permanently gave up: tear down the dead socket and reconnect.
  const reconnect = useCallback(() => {
    setConnectionFailed(false);
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    connect();
  }, [connect]);

  const subscribe = useCallback((sessionId: string, eventsList: string[]) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('message', {
        type: 'subscribe',
        sessionId,
        events: eventsList,
      });
    }
  }, []);

  const unsubscribe = useCallback((sessionId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('message', {
        type: 'unsubscribe',
        sessionId,
      });
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [connect]);

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
            reactions: (data.reactions as Record<string, string>) || {},
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
  }, [events]);

  return { isConnected, connectionFailed, reconnect, subscribe, unsubscribe };
}
