import { DateTransformer } from './date.transformer';

// DateTransformer.to() resolves the DATA connection dialect from the global DATABASE_TYPE.
// Characterization tests lock the round-trip behavior (previously untested).
describe('DateTransformer (cross-DB date round-trip)', () => {
  const original = process.env.DATABASE_TYPE;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_TYPE;
    else process.env.DATABASE_TYPE = original;
  });

  it('from(): parses ISO strings to Date, passes a Date through, maps null to null', () => {
    const parsed = DateTransformer.from('2026-06-20T10:00:00.000Z') as Date;
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe('2026-06-20T10:00:00.000Z');

    const now = new Date();
    expect(DateTransformer.from(now)).toBe(now);
    expect(DateTransformer.from(null)).toBeNull();
  });

  it('to(): stores an ISO string on SQLite and a native Date on Postgres; null stays null', () => {
    const d = new Date('2026-06-20T10:00:00.000Z');

    process.env.DATABASE_TYPE = 'sqlite';
    expect(DateTransformer.to(d)).toBe('2026-06-20T10:00:00.000Z');

    process.env.DATABASE_TYPE = 'postgres';
    expect(DateTransformer.to(d)).toBe(d);

    expect(DateTransformer.to(null)).toBeNull();
  });
});
