import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateSessionConfigDto } from './session-config.dto';

/**
 * Instantiate the way the global pipe does (src/config/app-validation.ts), including
 * `enableImplicitConversion`. Validating a hand-built instance instead would pass while the real
 * request path fails: implicit conversion runs BEFORE the validators and is the whole hazard here.
 */
const parse = (body: Record<string, unknown>): UpdateSessionConfigDto =>
  plainToInstance(UpdateSessionConfigDto, body, { enableImplicitConversion: true });

const errorsFor = (body: Record<string, unknown>): ReturnType<typeof validateSync> => validateSync(parse(body));

describe('UpdateSessionConfigDto', () => {
  it('accepts an empty body — every key is optional', () => {
    expect(errorsFor({})).toHaveLength(0);
  });

  describe('null clears a key', () => {
    it.each(['autoRejectCalls', 'maxReconnectAttempts', 'reconnectBaseDelay'])(
      'accepts an explicit null for %s and preserves it as null',
      key => {
        expect(errorsFor({ [key]: null })).toHaveLength(0);
        // The service distinguishes null (delete the key) from undefined (leave it alone), so the
        // null must survive transformation as a real null rather than being coerced or dropped.
        expect(parse({ [key]: null })[key as keyof UpdateSessionConfigDto]).toBeNull();
      },
    );
  });

  describe('autoRejectCalls', () => {
    it.each([
      [true, true],
      [false, false],
      ['true', true],
      ['false', false],
    ])('reads %p as %p', (input, expected) => {
      expect(errorsFor({ autoRejectCalls: input })).toHaveLength(0);
      expect(parse({ autoRejectCalls: input }).autoRejectCalls).toBe(expected);
    });

    it("does not turn the string 'false' into true", () => {
      // The regression @ToStrictBoolean exists for: with enableImplicitConversion, class-transformer
      // casts ANY non-empty string to true before @IsBoolean() can object. A form-encoded body
      // delivers scalars as strings, so an operator turning the toggle OFF would turn it ON.
      expect(parse({ autoRejectCalls: 'false' }).autoRejectCalls).toBe(false);
    });

    it.each(['yes', '1', 'off', ''])('rejects the ambiguous spelling %p rather than guessing', input => {
      expect(errorsFor({ autoRejectCalls: input }).length).toBeGreaterThan(0);
    });
  });

  describe('bounds mirror resolveReconnectConfig', () => {
    it.each([0, 1, 20])('accepts maxReconnectAttempts %i', v => {
      expect(errorsFor({ maxReconnectAttempts: v })).toHaveLength(0);
    });

    it.each([-1, 21, 1.5])('rejects maxReconnectAttempts %p', v => {
      expect(errorsFor({ maxReconnectAttempts: v }).length).toBeGreaterThan(0);
    });

    it.each([1000, 5000, 300000])('accepts reconnectBaseDelay %i', v => {
      expect(errorsFor({ reconnectBaseDelay: v })).toHaveLength(0);
    });

    it.each([999, 300001, 2.5])('rejects reconnectBaseDelay %p', v => {
      expect(errorsFor({ reconnectBaseDelay: v }).length).toBeGreaterThan(0);
    });

    it('rejects a non-numeric string instead of silently reading it as 0', () => {
      // Number('') and Number('  ') are both 0, and 0 means "never reconnect" — a meaningful value.
      // @ToStrictNumber leaves these unconverted so @IsInt() rejects them.
      expect(errorsFor({ maxReconnectAttempts: '' }).length).toBeGreaterThan(0);
      expect(errorsFor({ maxReconnectAttempts: 'lots' }).length).toBeGreaterThan(0);
    });

    it('accepts a numeric string, which is how a form-encoded body arrives', () => {
      expect(errorsFor({ reconnectBaseDelay: '5000' })).toHaveLength(0);
      expect(parse({ reconnectBaseDelay: '5000' }).reconnectBaseDelay).toBe(5000);
    });
  });
});
