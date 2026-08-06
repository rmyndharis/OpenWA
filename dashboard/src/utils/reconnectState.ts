export interface ReconnectState {
  isConnected: boolean;
  hadConnected: boolean;
  wasDisconnected: boolean;
}

export interface ReconnectDecision {
  invalidate: boolean;
  hadConnected: boolean;
  wasDisconnected: boolean;
}

/**
 * Pure state transition that detects a WebSocket RECONNECT — a connect that follows a disconnect
 * after the initial connection. Extracted from the component so the transition is unit-testable
 * independent of React/socket.io.
 *
 * A reconnect means realtime events (message.received/ack/revoke) were missed during the gap. The
 * chat message cache uses staleTime:Infinity, so it won't refetch on its own; the caller invalidates
 * on `invalidate: true` to force a refresh of the thread the gap left stale.
 *
 * - First connect (hadConnected false): no invalidate — nothing is cached yet to refresh.
 * - Disconnect after the first connect: mark a gap (wasDisconnected), no invalidate.
 * - Connect with a marked gap: RECONNECT — invalidate, then clear the gap marker.
 * - Disconnect before any connect (transient noise on mount): no gap marked (avoid a spurious first-
 *   connect invalidate if isConnected toggles false→true before the real first connect).
 */
export function nextReconnectState(state: ReconnectState): ReconnectDecision {
  if (state.isConnected) {
    return {
      invalidate: state.wasDisconnected,
      hadConnected: true,
      wasDisconnected: false,
    };
  }
  return {
    invalidate: false,
    hadConnected: state.hadConnected,
    wasDisconnected: state.hadConnected,
  };
}
