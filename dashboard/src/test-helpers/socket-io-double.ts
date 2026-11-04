/**
 * Stand-in for `socket.io-client` under the bare `node --test` runner, aliased by
 * vite-shim-hooks.mjs.
 *
 * A test cannot use the real client: there is no server, so `io()` dials and fails, and nothing can
 * push a server event into the page. That left every realtime handler in the dashboard untested —
 * which is how a chat cache read as the wrong shape reached review with green CI. This double never
 * dials; it records listeners and lets a test deliver an envelope with `lastSocket().receive(...)`.
 *
 * It keeps what the page sends as well, so a test can fail when the page stops sending it: the arguments
 * of `io()` (`lastIoCall()`, which carries the handshake's API key) and every `emit` of the socket
 * (`lastSocket().emitted`, the subscribe and unsubscribe frames). The manager (`socket.io`) takes
 * listeners too and delivers its own events, as in `lastSocket().io.receive('reconnect_failed')`.
 *
 * Like the real client, a socket is not connected until 'connect' is delivered to it, and is not after
 * 'disconnect' is.
 *
 * Tests that do not set `sessionStorage['openwa_api_key']` never reach `io()` at all (useWebSocket
 * bails first), so aliasing this in changes nothing for them.
 */

type Listener = (...args: unknown[]) => void;

/** The listeners of one emitter, and the delivery of an event to them. */
class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener?: Listener): this {
    if (listener === undefined) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** Deliver a frame to whatever the page registered for `event`. */
  receive(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** Where the client's reconnection events (`reconnect_failed` and the like) are delivered. */
class FakeManager extends Emitter {}

class FakeSocket extends Emitter {
  connected = false;
  readonly io = new FakeManager();
  /** Every frame the page sent with `emit`, in order. */
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];

  override on(event: string, listener: Listener): this {
    super.on(event, listener);
    // The real client fires 'connect' asynchronously after the handshake; do it on registration so
    // a page that gates its subscribe on connection reaches the same state.
    if (event === 'connect' && autoConnect) {
      queueMicrotask(() => {
        this.connected = true;
        listener();
      });
    }
    return this;
  }

  override receive(event: string, ...args: unknown[]): void {
    if (event === 'connect') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    super.receive(event, ...args);
  }

  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }
}

let last: FakeSocket | null = null;
let lastCall: { url: string; options: Record<string, unknown> } | null = null;
let autoConnect = true;

export function io(url = '', options: Record<string, unknown> = {}): FakeSocket {
  last = new FakeSocket();
  lastCall = { url, options };
  return last;
}

/** The socket the page most recently opened, or null if it never got as far as opening one. */
export function lastSocket(): FakeSocket | null {
  return last;
}

/** What the page passed to its most recent `io()`, or null if it never dialled. */
export function lastIoCall(): { url: string; options: Record<string, unknown> } | null {
  return lastCall;
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
  lastCall = null;
  autoConnect = true;
}

// A VALUE export, not `export type`: useWebSocket imports `Socket` from a value position, and only
// files that also read `import.meta.env` go through the transpiler that would elide it.
export { FakeSocket as Socket };
export default { io };
