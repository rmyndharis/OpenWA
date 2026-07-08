import { computeFeatureFlags, resolveFeatureFlags, FeatureFlags } from './feature-flags';

describe('feature-flags', () => {
  describe('computeFeatureFlags', () => {
    it('applies the documented defaults for an empty environment', () => {
      const flags = computeFeatureFlags({});
      expect(flags).toEqual<FeatureFlags>({
        autoStartSessions: false, // opt-in
        storeEphemeralMessages: true, // opt-out
        resolveLidToPhone: false, // opt-in
        simulateTyping: true, // opt-out
        simulateTypingMaxMs: 5000,
      });
    });

    it('treats opt-in flags (autoStart, resolveLid) as ON only for the exact string "true"', () => {
      expect(computeFeatureFlags({ AUTO_START_SESSIONS: 'true' }).autoStartSessions).toBe(true);
      expect(computeFeatureFlags({ RESOLVE_LID_TO_PHONE: 'true' }).resolveLidToPhone).toBe(true);
      // Anything else stays OFF.
      for (const v of ['false', 'TRUE', '1', 'yes', '']) {
        expect(computeFeatureFlags({ AUTO_START_SESSIONS: v }).autoStartSessions).toBe(false);
        expect(computeFeatureFlags({ RESOLVE_LID_TO_PHONE: v }).resolveLidToPhone).toBe(false);
      }
    });

    it('treats opt-out flags (storeEphemeral, simulateTyping) as OFF only for the exact string "false"', () => {
      expect(computeFeatureFlags({ STORE_EPHEMERAL_MESSAGES: 'false' }).storeEphemeralMessages).toBe(false);
      expect(computeFeatureFlags({ SIMULATE_TYPING: 'false' }).simulateTyping).toBe(false);
      // Anything else stays ON.
      for (const v of ['true', 'FALSE', '0', 'no', '']) {
        expect(computeFeatureFlags({ STORE_EPHEMERAL_MESSAGES: v }).storeEphemeralMessages).toBe(true);
        expect(computeFeatureFlags({ SIMULATE_TYPING: v }).simulateTyping).toBe(true);
      }
    });

    it('parses simulateTypingMaxMs with Number()||5000 semantics (0/negative/non-numeric fall back)', () => {
      expect(computeFeatureFlags({ SIMULATE_TYPING_MAX_MS: '3000' }).simulateTypingMaxMs).toBe(3000);
      // Critical: "0" must fall back to 5000 (Number('0')||5000), NOT stay 0 as parseInt would.
      expect(computeFeatureFlags({ SIMULATE_TYPING_MAX_MS: '0' }).simulateTypingMaxMs).toBe(5000);
      expect(computeFeatureFlags({ SIMULATE_TYPING_MAX_MS: '' }).simulateTypingMaxMs).toBe(5000);
      expect(computeFeatureFlags({ SIMULATE_TYPING_MAX_MS: 'abc' }).simulateTypingMaxMs).toBe(5000);
      expect(computeFeatureFlags({ SIMULATE_TYPING_MAX_MS: undefined }).simulateTypingMaxMs).toBe(5000);
    });
  });

  describe('resolveFeatureFlags', () => {
    const original = process.env.AUTO_START_SESSIONS;
    afterEach(() => {
      if (original === undefined) delete process.env.AUTO_START_SESSIONS;
      else process.env.AUTO_START_SESSIONS = original;
    });

    it('prefers the ConfigService-loaded features object when present', () => {
      const features = computeFeatureFlags({ AUTO_START_SESSIONS: 'true' });
      const configService = { get: jest.fn().mockReturnValue(features) };
      expect(resolveFeatureFlags(configService)).toBe(features);
      expect(configService.get).toHaveBeenCalledWith('features');
    });

    it('falls back to a live process.env read when ConfigService is absent', () => {
      process.env.AUTO_START_SESSIONS = 'true';
      expect(resolveFeatureFlags(undefined).autoStartSessions).toBe(true);
      process.env.AUTO_START_SESSIONS = 'false';
      expect(resolveFeatureFlags(undefined).autoStartSessions).toBe(false);
    });

    it('falls back to process.env when ConfigService has no "features" entry (e.g. a partial mock)', () => {
      process.env.AUTO_START_SESSIONS = 'true';
      const configService = { get: jest.fn().mockImplementation((_k: string, def?: unknown) => def) };
      expect(resolveFeatureFlags(configService).autoStartSessions).toBe(true);
    });
  });
});
