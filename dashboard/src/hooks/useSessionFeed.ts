import { useState, useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import type { Session } from '../services/api';
import { useWebSocket } from './useWebSocket';
import { createSessionFeedState, noteSessionFeedError, subscribeSessionFeed } from '../utils/sessionFeedSubscription';

export interface SessionFeed {
  isConnected: boolean;
}

export interface UseSessionFeedArgs {
  sessions: Session[];
  sessionsRef: RefObject<Session[]>;
  onQRCode: (event: { sessionId: string; qrCode: string }) => void;
  onSessionStatus: (event: { sessionId: string; status: string }) => void;
  onSessionRestriction?: (event: { sessionId: string }) => void;
}

/**
 * Owns the ONE `useWebSocket` call for the Sessions page plus the live session-feed subscription
 * (wildcard first, per-session fallback for scoped keys): `feedStateRef`, the transient
 * `feedErrorFrame`, and the four effects that keep the subscription correct across connect/reconnect
 * and roster changes. `useWebSocket` opens its own socket per call — a second call site anywhere else
 * on this page would double every handshake, subscribe storm, and `session.status` toast.
 *
 * `onQRCode`/`onSessionStatus` are owned by the caller (the page), not this hook: reacting to a status
 * push touches `sessions`/`selectedSession` state that lives in the page body (see the `useSessionList`
 * rejection), so this hook only wires the callbacks through — it never mutates the session list itself.
 */
export function useSessionFeed({
  sessions,
  sessionsRef,
  onQRCode,
  onSessionStatus,
  onSessionRestriction,
}: UseSessionFeedArgs): SessionFeed {
  // Live session-feed subscription state: wildcard first, per-session fallback for scoped keys.
  const feedStateRef = useRef(createSessionFeedState());
  // Most recent server error frame; folded into feedStateRef by the effect below (kept as state
  // so the fallback runs after `subscribe` exists — the handler can't reference it directly).
  const [feedErrorFrame, setFeedErrorFrame] = useState<{ code: string } | null>(null);

  const { isConnected, subscribe } = useWebSocket({
    onQRCode,
    onSessionStatus,
    onSessionRestriction,
    onServerError: useCallback((frame: { code: string }) => {
      setFeedErrorFrame(frame);
    }, []),
  });

  // Fold a server error frame into the feed state: a session-scoped key may not join the '*'
  // room — silently fall back to one subscription per listed session (the list endpoint is
  // already scope-filtered server-side), otherwise no status/QR push ever arrives and the QR
  // modal sits on "generating" forever.
  useEffect(() => {
    if (!feedErrorFrame) return;
    if (noteSessionFeedError(feedStateRef.current, feedErrorFrame.code)) {
      subscribeSessionFeed(
        { subscribe },
        feedStateRef.current,
        sessionsRef.current.map(s => s.id),
      );
    }
  }, [feedErrorFrame, subscribe, sessionsRef]);

  // Join the live session feed (wildcard attempt, or per-session rooms after a scope fallback).
  useEffect(() => {
    if (isConnected) {
      subscribeSessionFeed(
        { subscribe },
        feedStateRef.current,
        sessionsRef.current.map(s => s.id),
      );
    }
  }, [isConnected, subscribe, sessionsRef]);

  // Rooms are per-socket on the backend: a reconnect lands on a fresh socket with no
  // subscriptions, so the per-session dedup set must be forgotten or the join effect
  // above would skip every already-listed id and no feed frame would arrive again.
  useEffect(() => {
    if (!isConnected) feedStateRef.current.subscribedIds.clear();
  }, [isConnected]);

  // In per-session mode, sessions loaded/created after the fallback still need their rooms.
  useEffect(() => {
    if (isConnected && feedStateRef.current.scope === 'per-session') {
      subscribeSessionFeed(
        { subscribe },
        feedStateRef.current,
        sessions.map(s => s.id),
      );
    }
  }, [isConnected, sessions, subscribe]);

  return { isConnected };
}
