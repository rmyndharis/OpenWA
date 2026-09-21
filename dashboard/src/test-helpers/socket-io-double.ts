/**
 * Stand-in for `socket.io-client` under the bare `node --test` runner, aliased by
 * vite-shim-hooks.mjs.
 *
 * A test cannot use the real client: there is no server, so `io()` dials and fails, and nothing can
 * push a server event into the page. That left every realtime handler in the dashboard untested —
 * which is how a chat cache read as the wrong shape reached review with green CI. This double never
 * dials; it records listeners and lets a test deliver an envelope with `lastSocket().receive(...)`.
 *
 * Tests that do not set `sessionStorage['openwa_api_key']` never reach `io()` at all (useWebSocket
 * bails first), so aliasing this in changes nothing for them.
 */

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  connected = true;
  private listeners = new Map<string, Set<Listener>>();
  /** The manager namespace (`socket.io.on('reconnect_failed', …)`). */
  readonly io = { on: (): void => undefined };

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    // The real client fires 'connect' asynchronously after the handshake; do it on registration so
    // a page that gates its subscribe on connection reaches the same state.
    if (event === 'connect' && autoConnect) queueMicrotask(() => listener());
    return this;
  }

  off(event: string, listener?: Listener): this {
    if (listener === undefined) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(): this {
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  /** Deliver a server frame to whatever the page registered for `event`. */
  receive(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

let last: FakeSocket | null = null;
let autoConnect = true;

export function io(): FakeSocket {
  last = new FakeSocket();
  return last;
}

/** The socket the page most recently opened, or null if it never got as far as opening one. */
export function lastSocket(): FakeSocket | null {
  return last;
}

/**
 * Stop sockets from firing 'connect' on registration, so a test can deliver it with
 * `receive('connect')` in the same batch as the frames a real server sends alongside it.
 */
export function holdConnect(): void {
  autoConnect = false;
}

export function resetSocketDouble(): void {
  last = null;
  autoConnect = true;
}

// A VALUE export, not `export type`: useWebSocket imports `Socket` from a value position, and only
// files that also read `import.meta.env` go through the transpiler that would elide it.
export { FakeSocket as Socket };
export default { io };
