import { jsonColumnType, dateColumnType } from './column-types';

// These helpers resolve the DATA connection dialect from the global DATABASE_TYPE env var.
// Characterization tests lock the resolved type strings so any future change to the resolution is
// caught (the helpers were previously untested).
describe('cross-DB column type helpers (data connection dialect)', () => {
  const original = process.env.DATABASE_TYPE;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_TYPE;
    else process.env.DATABASE_TYPE = original;
  });

  it('resolves Postgres types when DATABASE_TYPE=postgres', () => {
    process.env.DATABASE_TYPE = 'postgres';
    expect(jsonColumnType()).toBe('jsonb');
    expect(dateColumnType()).toBe('timestamp');
  });

  it('resolves SQLite types when DATABASE_TYPE is sqlite or unset', () => {
    process.env.DATABASE_TYPE = 'sqlite';
    expect(jsonColumnType()).toBe('simple-json');
    expect(dateColumnType()).toBe('text');

    delete process.env.DATABASE_TYPE;
    expect(jsonColumnType()).toBe('simple-json');
    expect(dateColumnType()).toBe('text');
  });
});
