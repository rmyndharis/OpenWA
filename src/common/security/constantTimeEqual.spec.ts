import { constantTimeEqual } from './constantTimeEqual';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a-secret-token-1234567890', 'a-secret-token-1234567890')).toBe(true);
  });

  it('returns false for different content of the same length (the value compare still works)', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('secret-1', 'secret-2')).toBe(false);
  });

  it('returns false for different lengths (no early-return length leak — the digests are fixed-length)', () => {
    // The length-mismatch case must still resolve to false, just without branching on input length.
    expect(constantTimeEqual('a', 'ab')).toBe(false);
    expect(constantTimeEqual('short', 'a-much-longer-secret-value')).toBe(false);
    expect(constantTimeEqual('a-much-longer-secret-value', 'short')).toBe(false);
    expect(constantTimeEqual('', 'non-empty')).toBe(false);
    expect(constantTimeEqual('non-empty', '')).toBe(false);
  });

  it('handles multi-byte UTF-8 correctly (compares bytes, not chars)', () => {
    // 'é' is 2 UTF-8 bytes; 'e' is 1. Different bytes → not equal even though both "look like e".
    expect(constantTimeEqual('café', 'café')).toBe(true);
    expect(constantTimeEqual('café', 'cafe')).toBe(false);
    // Emoji are 4 bytes; equality must hold across them.
    expect(constantTimeEqual('🔑', '🔑')).toBe(true);
    expect(constantTimeEqual('🔑', '🔓')).toBe(false);
  });

  it('is reflexive and symmetric', () => {
    expect(constantTimeEqual('x', 'x')).toBe(true);
    expect(constantTimeEqual('x', 'y')).toBe(false);
    expect(constantTimeEqual('y', 'x')).toBe(false); // symmetric
  });
});
