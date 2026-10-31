import { NotFoundException } from '@nestjs/common';

interface WriteState {
  captures: number;
  closing: number;
  generation: { retired: boolean; listeners: Set<() => void> };
  writes: Set<Promise<unknown>>;
}

const sources = new WeakMap<object, Map<string, WriteState>>();

function stateFor(source: object, sessionId: string): [Map<string, WriteState>, WriteState] {
  let sessions = sources.get(source);
  if (!sessions) sources.set(source, (sessions = new Map<string, WriteState>()));
  let state = sessions.get(sessionId);
  if (!state) {
    state = { captures: 0, closing: 0, generation: { retired: false, listeners: new Set() }, writes: new Set() };
    sessions.set(sessionId, state);
  }
  return [sessions, state];
}

function releaseIdle(sessions: Map<string, WriteState>, sessionId: string, state: WriteState): void {
  if (!state.captures && !state.closing && !state.writes.size && sessions.get(sessionId) === state) {
    sessions.delete(sessionId);
  }
}

export interface SessionWriteScope {
  assertCurrent(): void;
  /** Release preparation resources immediately on retirement; close() also disposes the subscription. */
  onRetire(listener: () => void): () => void;
  write<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

/** Captures a lifetime without holding deletion across network or storage waits. */
export function captureSessionWrites(source: object, sessionId: string): SessionWriteScope {
  const [sessions, state] = stateFor(source, sessionId);
  const generation = state.generation;
  state.captures++;
  let closed = false;
  const subscriptions = new Set<() => void>();
  const assertCurrent = (): void => {
    if (closed || generation.retired || state.closing || sessions.get(sessionId) !== state) {
      throw new NotFoundException(`Session '${sessionId}' is no longer available`);
    }
  };
  return {
    assertCurrent,
    onRetire(listener: () => void): () => void {
      if (closed || generation.retired || state.closing || sessions.get(sessionId) !== state) {
        listener();
        return () => undefined;
      }
      const dispose = (): void => {
        generation.listeners.delete(notify);
        subscriptions.delete(dispose);
      };
      const notify = (): void => {
        dispose();
        listener();
      };
      generation.listeners.add(notify);
      subscriptions.add(dispose);
      return dispose;
    },
    async write<T>(operation: () => Promise<T>): Promise<T> {
      assertCurrent();
      const pending = Promise.resolve().then(operation);
      state.writes.add(pending);
      try {
        return await pending;
      } finally {
        state.writes.delete(pending);
        releaseIdle(sessions, sessionId, state);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const dispose of subscriptions) dispose();
      state.captures--;
      releaseIdle(sessions, sessionId, state);
    },
  };
}

/** Close admission synchronously; drain only database operations before deleting their parent. */
export function closeSessionWrites(source: object, sessionId: string): { drain(): Promise<void>; release(): void } {
  const [sessions, state] = stateFor(source, sessionId);
  state.closing++;
  state.generation.retired = true;
  for (const notify of state.generation.listeners) {
    try {
      notify();
    } catch {
      // A preparation cleanup failure must not prevent session deletion or other notifications.
    }
  }
  state.generation.listeners.clear();
  let released = false;
  return {
    async drain(): Promise<void> {
      await Promise.allSettled([...state.writes]);
    },
    release(): void {
      if (released) return;
      released = true;
      state.closing--;
      // A retry must still drain older writes; only the captured generation is retired.
      if (!state.closing) state.generation = { retired: false, listeners: new Set() };
      releaseIdle(sessions, sessionId, state);
    },
  };
}
