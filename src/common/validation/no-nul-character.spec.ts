import { containsNul } from './no-nul-character';

describe('containsNul', () => {
  it('returns false for scalars and clean containers', () => {
    for (const value of [null, undefined, 0, 42, true, false, '', 'clean', [], {}, { a: [1, { b: 'ok' }] }]) {
      expect(containsNul(value)).toBe(false);
    }
  });

  it('detects a NUL character in strings, arrays, and nested object values', () => {
    expect(containsNul('a\u0000b')).toBe(true);
    expect(containsNul(['ok', 'x\u0000'])).toBe(true);
    expect(containsNul({ outer: { inner: ['ok', { text: '\u0000' }] } })).toBe(true);
  });

  it('detects a NUL character in object keys at any depth', () => {
    expect(containsNul({ 'bad\u0000key': 'ok' })).toBe(true);
    expect(containsNul({ outer: { 'nested\u0000': 1 } })).toBe(true);
    expect(containsNul([{ headers: { 'X-Bad\u0000': 'value' } }])).toBe(true);

    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto['k\u0000'] = 'v';
    expect(containsNul(nullProto)).toBe(true);
  });
});
