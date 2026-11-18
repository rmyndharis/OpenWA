import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginLogLevel, SANDBOX_LOG_MAX_PER_WINDOW, SANDBOX_LOG_WINDOW_MS } from './sandbox/protocol';
import { WorkerLogLimiter } from './sandbox/worker-log-limiter';

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
