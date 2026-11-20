import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginLogLevel, SANDBOX_LOG_MAX_PER_WINDOW, SANDBOX_LOG_WINDOW_MS } from './sandbox/protocol';
import { SANDBOX_LOG_MAX_LINES_PER_WINDOW, WorkerLogLimiter } from './sandbox/worker-log-limiter';

type LogRelay = (level: PluginLogLevel, message: string) => void;
type LogRelayState = { windowStart: number; count: number; dropped: number };

/**
 * The worker's limiter feeds the host's log relay, and each keeps its own window. The relay counts every message it
 * reads, the limiter's notes included, so a limiter that admitted as many lines as the relay admits messages would have
 * its first-drop note refused by the relay: the one line that says the limit began would be the first dropped.
 */
describe('the worker log limiter feeding the host log relay', () => {
  let clock: number;
  let hostLines: string[];
  let relayWarnings: string[];
  let state: LogRelayState;
  let limiter: WorkerLogLimiter;
  let relay: LogRelay;

  beforeEach(() => {
    clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    hostLines = [];
    relayWarnings = [];
    const write = (message: string): void => {
      hostLines.push(message);
    };
    const context = { logger: { log: write, debug: write, warn: write, error: write } };
    const bridge = { logger: { warn: (message: string) => relayWarnings.push(message) } };
    state = { windowStart: Date.now(), count: 0, dropped: 0 };
    const buildLogRelay = (
      PluginSandboxBridge.prototype as unknown as {
        buildLogRelay: (pluginId: string, context: unknown, state: LogRelayState) => LogRelay;
      }
    ).buildLogRelay;
    relay = buildLogRelay.call(bridge, 'flood', context, state);
    // The worker's side: whatever the limiter posts, notes included, goes to the relay.
    limiter = new WorkerLogLimiter(
      note => relay('warn', note),
      () => clock,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A loop that logs `lines` times without yielding: every line the limiter admits is posted to the relay. */
  const flood = (lines: number): void => {
    for (let i = 0; i < lines; i++) if (limiter.admit()) relay('log', `line ${i}`);
  };
  const linesOf = (messages: string[]): string[] => messages.filter(message => /^line \d+$/.test(message));
  const firstDropNotesOf = (messages: string[]): string[] =>
    messages.filter(message => /log rate limit reached/i.test(message));

  it('puts the note that says the limit began in the host log, within what the relay admits', () => {
    flood(5000);

    expect(firstDropNotesOf(hostLines)).toHaveLength(1);
    expect(linesOf(hostLines)).toHaveLength(SANDBOX_LOG_MAX_PER_WINDOW - 2);
    expect(hostLines.length).toBeLessThanOrEqual(SANDBOX_LOG_MAX_PER_WINDOW);
    expect(state.dropped).toBe(0);
    expect(relayWarnings).toEqual([]);
  });

  it('keeps every window of a flood within the relay, the count of the window before included', () => {
    const windows = 4;
    for (let window = 0; window < windows; window++) {
      const before = hostLines.length;
      flood(5000);
      const delivered = hostLines.slice(before);

      expect(firstDropNotesOf(delivered)).toHaveLength(1);
      expect(linesOf(delivered)).toHaveLength(SANDBOX_LOG_MAX_PER_WINDOW - 2);
      // A window after the first also opens with the count of the drops before it, which fills the relay's bound.
      expect(delivered).toHaveLength(window === 0 ? SANDBOX_LOG_MAX_PER_WINDOW - 1 : SANDBOX_LOG_MAX_PER_WINDOW);
      expect(state.dropped).toBe(0);
      clock += SANDBOX_LOG_WINDOW_MS;
    }

    expect(hostLines.filter(message => /^Dropped \d+ log messages \(log rate limit\)$/.test(message))).toHaveLength(
      windows - 1,
    );
    expect(relayWarnings).toEqual([]);
  });

  it('relays every line of a plugin that stays within the bound, with no note', () => {
    flood(SANDBOX_LOG_MAX_PER_WINDOW - 2);

    expect(linesOf(hostLines)).toHaveLength(SANDBOX_LOG_MAX_PER_WINDOW - 2);
    expect(hostLines).toHaveLength(SANDBOX_LOG_MAX_PER_WINDOW - 2);
    expect(state.dropped).toBe(0);
  });
});

/**
 * The relay's window opens when the plugin is enabled, on the wall clock, and rolls at the first message at least 10 s
 * after it opened. The limiter's window opens at the plugin's first line, on the monotonic clock. The cases above start
 * both at one instant, as a flood that is the first thing the plugin logs does, and the two windows then agree from the
 * second one on. When a plugin has logged before it floods, the windows are out of step, and a burst that straddles a
 * boundary of the relay's window meets lines of the window before it: the relay refuses what is past its bound.
 */
describe('the worker log limiter feeding the host log relay with windows that open at different instants', () => {
  const WALL_START = 1_000_000;
  let wall: number;
  let monotonic: number;
  let hostLines: string[];
  let relayWarnings: string[];
  let state: LogRelayState;
  let limiter: WorkerLogLimiter;
  let relay: LogRelay;

  beforeEach(() => {
    wall = WALL_START;
    monotonic = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => wall);
    hostLines = [];
    relayWarnings = [];
    const write = (message: string): void => {
      hostLines.push(message);
    };
    const context = { logger: { log: write, debug: write, warn: write, error: write } };
    const bridge = { logger: { warn: (message: string) => relayWarnings.push(message) } };
    state = { windowStart: Date.now(), count: 0, dropped: 0 }; // the relay's first window opens at enable, at t = 0
    const buildLogRelay = (
      PluginSandboxBridge.prototype as unknown as {
        buildLogRelay: (pluginId: string, context: unknown, state: LogRelayState) => LogRelay;
      }
    ).buildLogRelay;
    relay = buildLogRelay.call(bridge, 'flood', context, state);
    limiter = new WorkerLogLimiter(
      note => relay('warn', note),
      () => monotonic,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Both clocks read `seconds` after the plugin was enabled. */
  const at = (seconds: number): void => {
    wall = WALL_START + seconds * 1000;
    monotonic = seconds * 1000;
  };
  const burst = (tag: string, attempts: number): void => {
    for (let i = 0; i < attempts; i++) if (limiter.admit()) relay('log', `${tag} ${i}`);
  };
  const firstDropNotesOf = (messages: string[]): string[] =>
    messages.filter(message => /log rate limit reached/i.test(message));

  it('can have the relay refuse the lines and the first-drop note of a burst that straddles its window, and then reports how many', () => {
    const lines = SANDBOX_LOG_MAX_LINES_PER_WINDOW;
    const relayBound = SANDBOX_LOG_MAX_PER_WINDOW;

    at(1);
    burst('start-up', 1); // the limiter's window opens here, a second after the relay's
    at(SANDBOX_LOG_WINDOW_MS / 1000 + 0.5);
    burst('first', 5000); // the rest of the limiter's window, and its first-drop note: the relay's window rolls
    at(SANDBOX_LOG_WINDOW_MS / 1000 + 1.5);
    burst('second', 5000); // the limiter's next window opens: its count note, a full window of lines, its first-drop note

    // The limiter keeps each of its windows within the relay's bound ...
    expect(state.count).toBeGreaterThan(relayBound);
    // ... but the relay's window holds the first burst and a part of the second, and refuses the rest of it.
    expect(state.dropped).toBe(2 * lines + 2 - relayBound);
    expect(hostLines.filter(message => message.startsWith('second '))).toHaveLength(relayBound - lines - 1);
    expect(firstDropNotesOf(hostLines)).toHaveLength(1);

    // Nothing is lost without a trace: the relay's own window rolls and it logs the count with the next message.
    at(SANDBOX_LOG_WINDOW_MS / 1000 + 12);
    burst('later', 1);
    expect(relayWarnings).toEqual([
      `Dropped ${2 * lines + 2 - relayBound} log messages from sandboxed plugin flood (log relay rate limit)`,
    ]);
  });
});
