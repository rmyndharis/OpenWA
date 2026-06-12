import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';

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

interface WebSocketEvents {
  onSessionStatus?: (event: SessionStatusEvent) => void;
  onQRCode?: (event: QRCodeEvent) => void;
  onMessage?: (event: MessageEvent) => void;
}

// Envelope the gateway emits on the 'message' channel for all domain events.
interface ServerMessage {
  type: string;
  payload?: { event: string; sessionId: string; data: unknown };
  timestamp: string;
}

// Use current origin for WebSocket (goes through nginx proxy in Docker)
// Falls back to env var or localhost for development
const SOCKET_URL = import.meta.env.VITE_WS_URL || window.location.origin;

export function useWebSocket(events: WebSocketEvents = {}) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Keep the latest callbacks in a ref so the single 'message' listener
  // (registered once on connect) always dispatches to the current handlers.
  const eventsRef = useRef<WebSocketEvents>(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;

    // Get API key from sessionStorage (same as api.ts)
    const apiKey = sessionStorage.getItem('openwa_api_key');

    if (!apiKey) {
      console.warn('[WebSocket] No API key found, skipping connection');
      return;
    }

    const socket = io(`${SOCKET_URL}/events`, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      auth: {
        apiKey,
      },
      extraHeaders: {
        'X-API-Key': apiKey,
      },
      query: {
        apiKey,
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[WebSocket] Connected');
      setIsConnected(true);
      // The gateway only emits to rooms a client has explicitly joined, so we
      // must subscribe after connecting. Subscribe to all sessions/events.
      socket.emit('message', {
        type: 'subscribe',
        sessionId: '*',
        events: ['*'],
        requestId: 'dashboard',
      });
    });

    socket.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
      setIsConnected(false);
    });

    socket.on('connect_error', error => {
      console.warn('[WebSocket] Connection error:', error.message);
    });

    // The gateway delivers all domain events on the 'message' channel using a
    // { type:'event', payload:{ event, sessionId, data }, timestamp } envelope.
    // Translate that into the typed callbacks the dashboard expects.
    socket.on('message', (msg: ServerMessage) => {
      if (!msg || msg.type !== 'event' || !msg.payload) return;
      const { event, sessionId, data } = msg.payload;
      const ts = msg.timestamp;
      const cb = eventsRef.current;

      switch (event) {
        case 'session.status':
          cb.onSessionStatus?.({ sessionId, status: (data as { status: string })?.status, timestamp: ts });
          break;
        case 'session.qr':
          cb.onQRCode?.({ sessionId, qrCode: (data as { qrCode: string })?.qrCode, timestamp: ts });
          break;
        case 'message.received':
          cb.onMessage?.({ sessionId, message: data as Record<string, unknown>, timestamp: ts });
          break;
        default:
          break;
      }
    });
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

  return { isConnected };
}
