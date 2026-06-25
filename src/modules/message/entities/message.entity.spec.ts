import { bigintToNumberTransformer } from './message.entity';

// bigint columns read back as a string on PostgreSQL but a number on SQLite; the transformer
// normalizes reads so the REST/SDK/MCP contract (always `number`) holds on both dialects.
describe('bigintToNumberTransformer (message.timestamp)', () => {
  it('coerces a PostgreSQL bigint string read to a number', () => {
    // ValueTransformer.from is typed `any`, so assert inline rather than binding to an `any` local.
    expect(bigintToNumberTransformer.from('1700000000')).toBe(1700000000);
    expect(typeof bigintToNumberTransformer.from('1700000000')).toBe('number');
  });

  it('passes a SQLite numeric read through unchanged', () => {
    expect(bigintToNumberTransformer.from(1700000000)).toBe(1700000000);
  });

  it('preserves null', () => {
    expect(bigintToNumberTransformer.from(null)).toBeNull();
  });

  it('writes values through unchanged', () => {
    expect(bigintToNumberTransformer.to(1700000000)).toBe(1700000000);
    expect(bigintToNumberTransformer.to(null)).toBeNull();
  });
});
