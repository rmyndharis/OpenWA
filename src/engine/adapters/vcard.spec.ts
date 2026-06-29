import { buildVCard } from './vcard';

describe('buildVCard', () => {
  it('strips CR/LF from name and number so extra vCard lines cannot be injected', () => {
    const vcard = buildVCard({ name: 'Alice\r\nEMAIL:attacker@evil.com', number: '+1 234\r\nNOTE:x' });
    const lines = vcard.split('\n');
    // No injected lines — exactly the five canonical vCard lines. The crafted text is folded into the
    // FN/TEL values as inline text rather than becoming a standalone EMAIL/NOTE property line.
    expect(lines).toHaveLength(5);
    expect(lines.some(l => l.startsWith('EMAIL:') || l.startsWith('NOTE:'))).toBe(false);
    expect(lines[0]).toBe('BEGIN:VCARD');
    expect(lines[4]).toBe('END:VCARD');
  });

  it('reduces the waid to digits only', () => {
    const vcard = buildVCard({ name: 'Bob', number: '+1 (234) 567-8900' });
    expect(vcard).toContain('waid=12345678900:');
  });

  it('produces a VERSION:3.0 vCard with FN and TEL', () => {
    const vcard = buildVCard({ name: 'Carol', number: '628123' });
    expect(vcard.split('\n')).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Carol',
      'TEL;type=CELL;type=VOICE;waid=628123:628123',
      'END:VCARD',
    ]);
  });
});
